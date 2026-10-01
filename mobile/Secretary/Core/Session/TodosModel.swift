import Connect
import Foundation
import Observation
import SwiftProtobuf

public enum TodoFilter: String, CaseIterable, Identifiable {
    case all, open, done, blocked, skipped
    public var id: String { rawValue }
    public func includes(_ status: Secretary_V1_TodoStatus) -> Bool {
        switch self {
        case .all: true
        case .open: status == .todo || status == .doing
        case .done: status == .done
        case .blocked: status == .blocked
        case .skipped: status == .skipped
        }
    }
}

@MainActor @Observable
public final class TodosModel {
    public private(set) var items: [Secretary_V1_Todo] = []
    public private(set) var pending: [PendingOperation] = []
    public private(set) var rejected: Set<String> = []
    public private(set) var enabled = false
    public private(set) var busy = false
    public private(set) var canDelete = false
    public private(set) var message: String?
    public private(set) var cached = true
    public var filter: TodoFilter = .open
    public var visible: [Secretary_V1_Todo] { items.filter { filter.includes($0.status) } }
    public var canMutate: Bool { enabled && !busy && pending.isEmpty && !cached }
    @ObservationIgnored public var onAuthenticationFailure: (() -> Void)?
    @ObservationIgnored public var onMutation: (() async -> Void)?
    private let api: any TodosAPI
    private let store: DraftRepository
    private var credentials: Credentials?
    private var epoch = 0

    public init(store: DraftRepository, api: any TodosAPI = BackendAPI()) { self.store = store; self.api = api }
    public func activate(_ credentials: Credentials) {
        if self.credentials != credentials { clear() }
        self.credentials = credentials; enabled = true
    }
    public func suspend() { epoch += 1; enabled = false; busy = false; canDelete = false; cached = true }
    public func clear() { suspend(); credentials = nil; items = []; pending = []; rejected = []; message = nil }

    public func refresh() async {
        guard enabled, !busy, let credentials else { return }
        let attempt = epoch
        let scope = AccountScope(backend: credentials.backend, userID: credentials.userID)
        busy = true; message = nil
        defer { if epoch == attempt { busy = false } }
        do {
            let commands = try await store.retainedCommands(scope: scope)
            let rejectedIDs = try await store.rejectedCommands(scope: scope)
            guard epoch == attempt else { return }
            pending = commands; rejected = rejectedIDs
            if items.isEmpty, let data = try await store.cached(scope: scope, key: "todos") {
                let response = try Secretary_V1_ListTodosResponse(serializedBytes: data)
                guard epoch == attempt else { return }
                items = response.todos; cached = true
            }
            let todos = try await api.todos(credentials)
            guard epoch == attempt else { return }
            guard todos.allSatisfy({ $0.userID == credentials.userID }) else { throw SessionError.invalidIdentity }
            var response = Secretary_V1_ListTodosResponse(); response.todos = todos
            try await store.cache(scope: scope, key: "todos", data: response.serializedData())
            let permission = (try? await api.canDeleteTodos(credentials)) ?? false
            guard epoch == attempt else { return }
            items = todos; cached = false; canDelete = permission
        } catch {
            guard epoch == attempt else { return }
            cached = true; handle(error)
        }
    }

    public func save(original: Secretary_V1_Todo?, name: String, description: String, status: Secretary_V1_TodoStatus) async -> Bool {
        guard canMutate, let credentials, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if let original, original.name == name, original.desc == description, original.status == status { return true }
        let mutation = UUID().uuidString.lowercased()
        let scope = AccountScope(backend: credentials.backend, userID: credentials.userID)
        do {
            let bytes: Data
            let kind: PendingOperation.Kind
            if let original {
                guard original.userID == credentials.userID else { throw SessionError.invalidIdentity }
                var request = Secretary_V1_UpdateTodoRequest()
                request.id = original.id; request.workspaceID = original.workspaceID
                request.protocolVersion = 1; request.mutationID = mutation
                if original.name != name { request.patch.name = name }
                if original.desc != description { request.patch.desc = description }
                if original.status != status { request.patch.status = status }
                bytes = try request.jsonUTF8Data(); kind = .updateTodo
            } else {
                var request = Secretary_V1_CreateTodoRequest()
                request.name = name; request.desc = description; request.status = status; request.userID = credentials.userID
                request.protocolVersion = 1; request.mutationID = mutation
                bytes = try request.jsonUTF8Data(); kind = .createTodo
            }
            let operation = PendingOperation(scope: scope, kind: kind, mutationID: mutation, requestBytes: bytes,
                submittedSnapshot: try (original ?? Secretary_V1_Todo()).serializedData(), submittedGeneration: 0, expectedRevision: nil)
            return await submit(operation)
        } catch { handle(error); return false }
    }

    public func delete(_ todo: Secretary_V1_Todo) async -> Bool {
        guard canMutate, canDelete, let credentials, todo.userID == credentials.userID else { return false }
        do {
            var request = Secretary_V1_DeleteTodoRequest()
            request.id = todo.id; request.workspaceID = todo.workspaceID
            request.protocolVersion = 1; request.mutationID = UUID().uuidString.lowercased()
            return await submit(PendingOperation(scope: AccountScope(backend: credentials.backend, userID: credentials.userID),
                kind: .deleteTodo, mutationID: request.mutationID, requestBytes: try request.jsonUTF8Data(),
                submittedSnapshot: try todo.serializedData(), submittedGeneration: 0, expectedRevision: nil))
        } catch { handle(error); return false }
    }

    private func submit(_ operation: PendingOperation) async -> Bool {
        guard !busy else { return false }
        let attempt = epoch
        busy = true
        do {
            try await store.retainCommand(operation)
            guard attempt == epoch else { return false }
            pending.append(operation); busy = false
            return await retry(operation)
        } catch {
            guard attempt == epoch else { return false }
            busy = false; handle(error); return false
        }
    }

    @discardableResult public func retry(_ operation: PendingOperation) async -> Bool {
        guard enabled, !busy, !rejected.contains(operation.mutationID), let credentials,
              operation.scope == AccountScope(backend: credentials.backend, userID: credentials.userID) else { return false }
        let attempt = epoch
        busy = true; message = nil
        do {
            guard try await store.retainedCommands(scope: operation.scope).contains(operation), epoch == attempt else { throw DocumentEditError.unresolved }
            let data = try await api.sendRetained(operation, credentials: credentials)
            guard epoch == attempt else { return false }
            let receipt: String
            switch operation.kind {
            case .createTodo:
                let response = try Secretary_V1_CreateTodoResponse(jsonUTF8Data: data)
                guard response.todo.id > 0, response.todo.userID == credentials.userID else { throw DocumentEditError.invalidReceipt }
                receipt = response.mutationID
            case .updateTodo:
                let response = try Secretary_V1_UpdateTodoResponse(jsonUTF8Data: data)
                let request = try Secretary_V1_UpdateTodoRequest(jsonUTF8Data: operation.requestBytes)
                guard response.todo.id == request.id, response.todo.userID == credentials.userID else { throw DocumentEditError.invalidReceipt }
                receipt = response.mutationID
            case .deleteTodo: receipt = try Secretary_V1_DeleteTodoResponse(jsonUTF8Data: data).mutationID
            default: throw DocumentEditError.invalidReceipt
            }
            guard receipt == operation.mutationID else { throw DocumentEditError.invalidReceipt }
            try await store.finishCommand(operation)
            guard epoch == attempt else { return false }
            pending.removeAll { $0.mutationID == operation.mutationID }
            busy = false; cached = true
            await onMutation?()
            await refresh()
            return true
        } catch {
            guard epoch == attempt else { return false }
            if let code = (error as? ConnectError)?.code,
               [.invalidArgument, .notFound, .failedPrecondition, .aborted, .alreadyExists, .unimplemented].contains(code) {
                do {
                    try await store.rejectCommand(operation, message: error.localizedDescription)
                    guard epoch == attempt else { return false }
                    rejected.insert(operation.mutationID)
                } catch { /* Keep the immutable command if recording rejection fails. */ }
            }
            busy = false; handle(error); return false
        }
    }

    public func discardRejected(_ operation: PendingOperation) async {
        guard enabled, !busy, rejected.contains(operation.mutationID), let credentials,
              operation.scope == AccountScope(backend: credentials.backend, userID: credentials.userID) else { return }
        let attempt = epoch; busy = true
        do {
            try await store.finishCommand(operation)
            guard epoch == attempt else { return }
            pending.removeAll { $0.mutationID == operation.mutationID }; rejected.remove(operation.mutationID)
            busy = false; await refresh()
        } catch { if epoch == attempt { busy = false; handle(error) } }
    }

    private func handle(_ error: Error) {
        message = error.localizedDescription
        if (error as? ConnectError)?.code == .unauthenticated { onAuthenticationFailure?() }
    }

    public func retainedName(_ operation: PendingOperation) -> String {
        switch operation.kind {
        case .createTodo: (try? Secretary_V1_CreateTodoRequest(jsonUTF8Data: operation.requestBytes).name) ?? "New TODO"
        case .updateTodo:
            (try? Secretary_V1_UpdateTodoRequest(jsonUTF8Data: operation.requestBytes).patch.name).flatMap { $0.isEmpty ? nil : $0 }
                ?? (try? Secretary_V1_Todo(serializedBytes: operation.submittedSnapshot).name) ?? "TODO"
        default: (try? Secretary_V1_Todo(serializedBytes: operation.submittedSnapshot).name) ?? "TODO"
        }
    }
}
