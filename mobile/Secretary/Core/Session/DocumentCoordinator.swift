import Connect
import Foundation
import Observation
import SwiftProtobuf

public protocol DocumentAPI: Sendable {
    func document(_ credentials: Credentials, id: Int64) async throws -> Secretary_V1_Document
    func sendRetained(_ operation: PendingOperation, credentials: Credentials) async throws -> Data
}
extension BackendAPI: DocumentAPI {}

@MainActor @Observable
public final class MutationSession {
    public private(set) var credentials: Credentials?
    private var epoch = 0
    public init() {}
    public func activate(_ credentials: Credentials) { epoch += 1; self.credentials = credentials }
    public func suspend() { epoch += 1; credentials = nil }
    public struct Ticket: Sendable { let credentials: Credentials; let epoch: Int }
    public func ticket(scope: AccountScope) throws -> Ticket {
        guard let credentials, AccountScope(backend: credentials.backend, userID: credentials.userID) == scope else {
            throw DocumentEditError.unavailable
        }
        return Ticket(credentials: credentials, epoch: epoch)
    }
    public func current(_ ticket: Ticket) -> Bool { epoch == ticket.epoch && credentials == ticket.credentials }
}

/// Network work is owned by the account, never by a view's lifetime. Repository
/// transitions are atomic; `running` prevents duplicate sends across suspensions.
public actor DocumentCoordinator {
    public let key: String
    public let scope: AccountScope
    private let store: DraftRepository
    private let api: any DocumentAPI
    private let session: MutationSession
    private var running = false
    private var persistenceBlocked = false

    public init(key: String, scope: AccountScope, store: DraftRepository, api: any DocumentAPI, session: MutationSession) {
        self.key = key; self.scope = scope; self.store = store; self.api = api; self.session = session
    }

    public func record() async throws -> StoredDraft {
        guard let result = try await store.load(scope: scope, key: key) else { throw DocumentEditError.missingDraft }
        return result
    }

    public func initialize(_ document: Secretary_V1_Document, existing: Bool) async throws -> StoredDraft {
        let normalized = try existing ? DocumentRules.versioned(document) : DocumentRules.normalized(document)
        let data = try normalized.serializedData()
        return try await store.transition(scope: scope, key: key) { previous in
            previous ?? StoredDraft(snapshot: data, baseline: existing ? data : nil)
        }
    }

    public func edit(_ document: Secretary_V1_Document) async throws -> StoredDraft {
        do {
            let result = try await store.transition(scope: scope, key: key) { previous in
                guard var record = previous, record.deleted != true, record.archived != true, record.pending?.kind != .deleteDocument else {
                    throw DocumentEditError.unresolved
                }
                var draft = document
                if let baseline = record.baseline { draft = try DocumentRules.reconcile(draft, saved: DocumentRules.decode(baseline)) }
                record.snapshot = try DocumentRules.normalized(draft).serializedData()
                record.generation += 1
                return record
            }
            persistenceBlocked = false
            return result
        } catch {
            switch error {
            case DocumentEditError.unresolved: break
            default: persistenceBlocked = true
            }
            throw error
        }
    }

    public func flush(deleting: Bool = false) async throws {
        guard !persistenceBlocked else { throw DocumentEditError.unresolved }
        guard !running else { return }
        running = true
        defer { running = false }
        let ticket = try await session.ticket(scope: scope)
        do {
            if deleting {
                _ = try await store.transition(scope: scope, key: key) { previous in
                    guard var record = previous else { throw DocumentEditError.missingDraft }
                    record.pending = try DocumentRules.prepare(record, scope: self.scope, deleting: true)
                    return record
                }
            }
            while true {
                guard !persistenceBlocked, await session.current(ticket) else { return }
                var current = try await record()
                guard current.deleted != true, current.archived != true, current.conflict == nil else { return }
                if current.pending == nil, current.needsRefresh == true {
                    try await refresh(ticket)
                    current = try await record()
                    guard current.conflict == nil else { return }
                }
                guard current.pending != nil || current.dirty else { return }
                if current.pending == nil {
                    current = try await store.transition(scope: scope, key: key) { previous in
                        guard var record = previous else { throw DocumentEditError.missingDraft }
                        record.pending = try DocumentRules.prepare(record, scope: self.scope)
                        record.lastError = nil
                        return record
                    }
                }
                guard let operation = current.pending, operation.scope == scope,
                      !persistenceBlocked, await session.current(ticket) else { return }
                try DocumentRules.validateEnvelope(operation)
                let bytes = try await api.sendRetained(operation, credentials: ticket.credentials)
                guard await session.current(ticket) else { return }
                if operation.kind == .deleteDocument {
                    let response = try Secretary_V1_DeleteDocumentResponse(jsonUTF8Data: bytes)
                    let submitted = try DocumentRules.decode(operation.submittedSnapshot)
                    guard response.mutationID == operation.mutationID,
                          response.effects.deletedDocumentIds.contains(submitted.id) else { throw DocumentEditError.invalidReceipt }
                    _ = try await store.transition(scope: scope, key: key, invalidateCache: true) { previous in
                        guard var record = previous, record.pending == operation else { throw DocumentEditError.unresolved }
                        guard record.generation == operation.submittedGeneration else { throw DocumentEditError.unresolved }
                        record.pending = nil; record.deleted = true; record.lastError = nil
                        record.acknowledgedGeneration = record.generation
                        return record
                    }
                    return
                }
                guard operation.kind == .saveDocument else { throw DocumentEditError.invalidReceipt }
                let response = try Secretary_V1_SaveDocumentResponse(jsonUTF8Data: bytes)
                let saved = try DocumentRules.validate(response, operation: operation)
                _ = try await store.transition(scope: scope, key: key, invalidateCache: true) { previous in
                    guard var record = previous, record.pending == operation else { throw DocumentEditError.unresolved }
                    if response.outcome == .existingJournal {
                        let submitted = try DocumentRules.decode(operation.submittedSnapshot)
                        if submitted.blocks.isEmpty, submitted.title.isEmpty || submitted.title == submitted.journalDate,
                           record.generation == operation.submittedGeneration {
                            record.snapshot = try saved.serializedData()
                        } else {
                            record.conflict = "A journal already exists for this date. Your edited draft is retained."
                            record.serverCopy = try saved.serializedData(); record.rejected = true
                            record.pending = nil
                            return record
                        }
                    } else {
                        let latest = try DocumentRules.decode(record.snapshot)
                        record.snapshot = try DocumentRules.reconcile(latest, saved: saved).serializedData()
                    }
                    record.baseline = try saved.serializedData()
                    record.acknowledgedGeneration = operation.submittedGeneration
                    record.pending = nil; record.lastError = nil
                    // Receipt replay may be historical. Persist this barrier before any later mutation.
                    record.needsRefresh = true
                    return record
                }
                try await refresh(ticket)
            }
        } catch {
            guard await session.current(ticket) else { return }
            let code = (error as? ConnectError)?.code
            let definitive = code.map { [.aborted, .invalidArgument, .notFound, .alreadyExists, .failedPrecondition, .outOfRange, .unimplemented].contains($0) } ?? false
            let details: [Secretary_V1_PersistenceError] = (error as? ConnectError)?.unpackedDetails() ?? []
            let message: String
            switch details.first?.reason {
            case .revisionConflict: message = "This document has a newer server revision. Review both copies before saving."
            case .documentDeleted: message = "This document was deleted on the server. Your local draft is retained."
            case .invalidDestination: message = "The destination folder is no longer available. Your draft is retained."
            case .invalidIdentity, .invalidTree, .mutationIDReused, .creationKeyExists:
                message = "The server rejected this document's identity or structure. Review or save a recovery copy."
            case .protocolUpgradeRequired: message = "The server requires a different persistence protocol. Your request is retained."
            default: message = error.localizedDescription
            }
            _ = try await store.transition(scope: scope, key: key) { previous in
                guard var record = previous else { throw DocumentEditError.missingDraft }
                record.lastError = message
                if definitive {
                    record.conflict = message; record.rejected = true
                }
                return record
            }
            if definitive { try? await reviewServer(ticket: ticket) }
            throw error
        }
    }

    /// Compare a live body, never a receipt, before allowing further writes.
    private func refresh(_ ticket: MutationSession.Ticket) async throws {
        let prior = try await record()
        guard let baselineData = prior.baseline else { return }
        let baseline = try DocumentRules.decode(baselineData)
        let live: Secretary_V1_Document?
        do { live = try DocumentRules.versioned(await api.document(ticket.credentials, id: baseline.id)) }
        catch let error as ConnectError where error.code == .notFound { live = nil }
        guard await session.current(ticket) else { return }
        if let live, live.id != baseline.id || live.clientKey != baseline.clientKey { throw DocumentEditError.invalidSnapshot }
        _ = try await store.transition(scope: scope, key: key) { previous in
            guard var record = previous, record.pending == nil else { throw DocumentEditError.unresolved }
            if let live {
                if record.dirty && live.revision != baseline.revision {
                    record.conflict = "The server changed while you were editing. Review both copies before saving."
                    record.serverCopy = try live.serializedData(); record.rejected = true
                } else if !record.dirty {
                    record.snapshot = try live.serializedData(); record.baseline = record.snapshot
                }
            } else {
                record.conflict = "This document was deleted on the server. Your local copy is retained."
                record.serverMissing = true; record.serverCopy = nil; record.rejected = true
            }
            record.needsRefresh = false
            return record
        }
    }

    public func refreshLive() async throws {
        guard !running else { return }
        running = true; defer { running = false }
        let ticket = try await session.ticket(scope: scope)
        let current = try await record()
        guard current.pending == nil else { throw DocumentEditError.unresolved }
        try await refresh(ticket)
    }

    public func reviewServer() async throws {
        guard !running else { return }
        running = true; defer { running = false }
        try await reviewServer(ticket: session.ticket(scope: scope))
    }

    private func reviewServer(ticket: MutationSession.Ticket) async throws {
        let current = try await record()
        let document = try DocumentRules.decode(current.snapshot)
        let id = try current.serverCopy.map { try DocumentRules.decode($0).id } ?? document.id
        guard id > 0 else { return }
        let live: Secretary_V1_Document?
        do { live = try DocumentRules.versioned(await api.document(ticket.credentials, id: id)) }
        catch let error as ConnectError where error.code == .notFound { live = nil }
        guard await session.current(ticket) else { return }
        _ = try await store.transition(scope: scope, key: key) { previous in
            guard var record = previous else { throw DocumentEditError.missingDraft }
            record.serverCopy = try live?.serializedData(); record.serverMissing = live == nil
            return record
        }
    }

    /// Only explicit rejection (or an already acknowledged operation) permits replacement.
    public func resolve(useServer: Bool) async throws {
        guard !running else { throw DocumentEditError.unresolved }
        _ = try await store.transition(scope: scope, key: key) { previous in
            guard var record = previous, record.conflict != nil,
                  record.pending == nil || record.rejected == true,
                  let data = record.serverCopy else { throw DocumentEditError.unresolved }
            let server = try DocumentRules.versioned(DocumentRules.decode(data))
            if useServer {
                record.snapshot = data
                record.generation += 1; record.acknowledgedGeneration = record.generation
            } else {
                var local = try DocumentRules.decode(record.snapshot)
                // Removed remote blocks become new blocks with fresh identities. Never resurrect stale IDs.
                let known = Set(server.blocks.map(\.clientKey))
                var replacement: [String: String] = [:]
                for block in local.blocks where !known.contains(block.clientKey) && block.id > 0 {
                    replacement[block.clientKey] = UUID().uuidString.lowercased()
                }
                for index in local.blocks.indices {
                    let oldKey = local.blocks[index].clientKey
                    if !known.contains(oldKey) { local.blocks[index].id = 0; local.blocks[index].todoID = 0 }
                    local.blocks[index].clientKey = replacement[oldKey] ?? oldKey
                    let parent = local.blocks[index].parentClientKey
                    local.blocks[index].parentClientKey = replacement[parent] ?? parent
                    local.blocks[index].parentBlockID = 0
                }
                local = try DocumentRules.reconcile(local, saved: server)
                record.snapshot = try local.serializedData(); record.generation += 1
            }
            record.baseline = data; record.pending = nil; record.conflict = nil; record.rejected = nil
            record.needsRefresh = false; record.serverCopy = nil; record.serverMissing = nil; record.lastError = nil
            return record
        }
    }

    public func reloadFromServer() async throws {
        guard !running else { throw DocumentEditError.unresolved }
        running = true; defer { running = false }
        let ticket = try await session.ticket(scope: scope)
        let previous = try await record()
        guard previous.pending == nil || previous.rejected == true else { throw DocumentEditError.unresolved }
        let document = try DocumentRules.decode(previous.snapshot)
        guard document.id > 0 else { throw DocumentEditError.unresolved }
        let live = try DocumentRules.versioned(await api.document(ticket.credentials, id: document.id))
        guard await session.current(ticket), live.id == document.id, live.clientKey == document.clientKey else {
            throw DocumentEditError.unavailable
        }
        _ = try await store.transition(scope: scope, key: key, invalidateCache: true) { current in
            guard var record = current, record.localVersion == previous.localVersion else { throw DraftStorageError.staleWriter }
            record.snapshot = try live.serializedData(); record.baseline = record.snapshot
            record.generation += 1; record.acknowledgedGeneration = record.generation
            record.pending = nil; record.conflict = nil; record.rejected = nil
            record.needsRefresh = false; record.serverCopy = nil; record.serverMissing = nil; record.lastError = nil
            return record
        }
    }

    /// Archive only resolved/rejected recovery. The snapshot remains in SQLite.
    public func archiveRecovery() async throws {
        guard !running else { throw DocumentEditError.unresolved }
        _ = try await store.transition(scope: scope, key: key) { previous in
            guard var record = previous, record.pending == nil || record.rejected == true else { throw DocumentEditError.unresolved }
            record.archived = true
            return record
        }
    }
}
