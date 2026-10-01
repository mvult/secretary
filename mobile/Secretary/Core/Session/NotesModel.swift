import Connect
import Foundation
import Observation
import SwiftProtobuf

@MainActor @Observable
public final class NotesModel {
    public private(set) var entries: [Secretary_V1_DocumentIndexEntry] = []
    public private(set) var directories: [Secretary_V1_Directory] = []
    public private(set) var body: Secretary_V1_Document?
    public private(set) var loading = false
    public private(set) var loadingBody = false
    public private(set) var mutating = false
    public private(set) var enabled = false
    public private(set) var cachedIndex = false
    public private(set) var cachedBody = false
    public private(set) var message: String?
    public private(set) var bodyMessage: String?
    public let editors: EditorLibrary
    @ObservationIgnored public var onAuthenticationFailure: (() -> Void)?
    private let api: any NotesAPI
    private let store: DraftRepository
    private var credentials: Credentials?
    private var epoch = 0
    private var bodyEpoch = 0
    private var needsRefresh = true

    public init(api: any NotesAPI, store: DraftRepository) {
        self.api = api; self.store = store
        editors = EditorLibrary(store: store)
        editors.onChange = { [weak self] in await self?.refresh() }
        editors.onAuthenticationFailure = { [weak self] in self?.onAuthenticationFailure?() }
    }
    public func activate(_ credentials: Credentials) {
        if self.credentials != credentials { clear() }
        self.credentials = credentials; enabled = true
        editors.activate(credentials)
    }
    public func suspend() {
        epoch += 1; bodyEpoch += 1; enabled = false
        editors.suspend()
        loading = false; loadingBody = false; mutating = false; needsRefresh = true
    }
    public func clear() {
        suspend(); credentials = nil; entries = []; directories = []; body = nil
        editors.clear()
        message = nil; bodyMessage = nil; cachedIndex = false; cachedBody = false
    }
    public func refresh() async {
        guard enabled, !loading, !mutating, let credentials else { return }
        let attempt = epoch
        let scope = AccountScope(backend: credentials.backend, userID: credentials.userID)
        loading = true; message = nil
        defer { if epoch == attempt { loading = false } }
        do {
            if entries.isEmpty, directories.isEmpty,
               let data = try await store.cached(scope: scope, key: "index") {
                let cached = try Secretary_V1_ListDocumentIndexResponse(serializedBytes: data)
                guard epoch == attempt else { return }
                entries = cached.entries; directories = cached.directories; cachedIndex = true
            }
            var result = Secretary_V1_ListDocumentIndexResponse()
            var cursor: Int64 = 0
            repeat {
                let page = try await api.index(credentials, before: cursor)
                guard epoch == attempt else { return }
                guard page.persistenceProtocolVersion == 1 else { throw SessionError.protocolUnsupported }
                guard page.entries.allSatisfy({ $0.workspaceID == scope.workspaceID }),
                      page.directories.allSatisfy({ $0.workspaceID == scope.workspaceID }),
                      page.nextBeforeID == 0 || (page.nextBeforeID > 0 && (cursor == 0 || page.nextBeforeID < cursor)) else {
                    throw URLError(.badServerResponse)
                }
                if cursor == 0 { result.directories = page.directories }
                result.entries += page.entries
                cursor = page.nextBeforeID
            } while cursor != 0
            result.persistenceProtocolVersion = 1
            try await store.cache(scope: scope, key: "index", data: result.serializedData())
            guard epoch == attempt else { return }
            entries = result.entries; directories = result.directories
            cachedIndex = false; needsRefresh = false
        } catch {
            guard epoch == attempt else { return }
            message = error.localizedDescription; needsRefresh = true; cachedIndex = true
            if (error as? ConnectError)?.code == .unauthenticated { onAuthenticationFailure?() }
        }
    }
    public func open(_ id: Int64) async {
        guard enabled, let credentials else { return }
        bodyEpoch += 1
        let attempt = bodyEpoch
        let scope = AccountScope(backend: credentials.backend, userID: credentials.userID)
        body = nil; bodyMessage = nil; cachedBody = false; loadingBody = true
        defer { if bodyEpoch == attempt { loadingBody = false } }
        do {
            if let data = try await store.cached(scope: scope, key: "body:\(id)") {
                let cached = try Secretary_V1_Document(serializedBytes: data)
                guard bodyEpoch == attempt else { return }
                body = cached; cachedBody = true
            }
            let document = try await api.document(credentials, id: id)
            guard bodyEpoch == attempt else { return }
            guard document.id == id, document.workspaceID == scope.workspaceID, document.revision > 0 else {
                throw URLError(.badServerResponse)
            }
            try await store.cache(scope: scope, key: "body:\(id)", data: document.serializedData())
            guard bodyEpoch == attempt else { return }
            body = document; cachedBody = false
        } catch {
            guard bodyEpoch == attempt else { return }
            if let code = (error as? ConnectError)?.code, code == .notFound || code == .permissionDenied {
                body = nil
                try? await store.cache(scope: scope, key: "body:\(id)", data: nil)
            }
            guard bodyEpoch == attempt else { return }
            bodyMessage = error.localizedDescription
            if (error as? ConnectError)?.code == .unauthenticated { onAuthenticationFailure?() }
        }
    }

    public enum DirectoryAction: Sendable {
        case create(name: String, parent: Int64)
        case rename(id: Int64, name: String)
        case move(id: Int64, parent: Int64)
        case delete(id: Int64)
    }
    public var canMutate: Bool { enabled && !loading && !mutating && !needsRefresh }
    @discardableResult public func changeDirectory(_ action: DirectoryAction) async -> Bool {
        guard canMutate, let credentials else { return false }
        let attempt = epoch
        mutating = true; message = nil
        do {
            switch action {
            case let .create(name, parent): try await api.createDirectory(credentials, name: name, parent: parent)
            case let .rename(id, name): try await api.updateDirectory(credentials, id: id, name: name, parent: nil)
            case let .move(id, parent): try await api.updateDirectory(credentials, id: id, name: nil, parent: parent)
            case let .delete(id): try await api.deleteDirectory(credentials, id: id)
            }
            guard epoch == attempt else { return false }
            mutating = false; needsRefresh = true
            await refresh()
            return true
        } catch {
            guard epoch == attempt else { return false }
            mutating = false; needsRefresh = true
            message = "\(error.localizedDescription) Refresh folders before trying again; the request may have reached the server."
            if (error as? ConnectError)?.code == .unauthenticated { onAuthenticationFailure?() }
            return false
        }
    }

    public func descendants(of id: Int64) -> Set<Int64> {
        var found: Set<Int64> = [id]
        var pending = [id]
        while let parent = pending.popLast() {
            for child in directories where child.parentID == parent {
                if found.insert(child.id).inserted { pending.append(child.id) }
            }
        }
        return found
    }
    public func canDelete(_ id: Int64) -> Bool {
        !directories.contains { $0.parentID == id } && !entries.contains { $0.directoryID == id }
    }
}
