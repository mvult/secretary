import Connect
import Foundation
import GRDB
import Observation
import SwiftProtobuf

@MainActor @Observable
public final class DocumentEditor: Identifiable {
    public let id: String
    public private(set) var document: Secretary_V1_Document
    public private(set) var stored: StoredDraft
    public private(set) var saving = false
    public private(set) var reloading = false
    public private(set) var persisting = false
    public private(set) var error: String?
    public private(set) var storageFailed = false
    public let session: MutationSession
    private let coordinator: DocumentCoordinator
    private var edits = 0
    private var deleting = false
    private var replacing = false
    private var persistence: Task<Void, Never>?
    private var debounce: Task<Void, Never>?
    @ObservationIgnored public var onChange: (() async -> Void)?
    @ObservationIgnored public var onAuthenticationFailure: (() -> Void)?

    public init(coordinator: DocumentCoordinator, record: StoredDraft, session: MutationSession) throws {
        self.coordinator = coordinator; self.id = coordinator.key; self.session = session
        stored = record; document = try DocumentRules.decode(record.snapshot)
    }

    public var editable: Bool { !replacing && !deleting && stored.deleted != true && stored.archived != true && stored.pending?.kind != .deleteDocument }
    public var status: String {
        if reloading { return "Reloading from server…" }
        if storageFailed { return "Local storage failed — edits are only in memory" }
        if persisting { return "Saving locally…" }
        if stored.deleted == true { return "Deleted" }
        if stored.archived == true { return "Recovery archived locally" }
        if stored.conflict != nil { return "Conflict — local draft retained" }
        if saving { return "Syncing…" }
        if stored.pending != nil { return "Request retained — retry to resolve" }
        if stored.dirty { return "Saved locally · waiting to sync" }
        if stored.needsRefresh == true { return "Saved · checking server" }
        return "Saved"
    }

    public func change(_ update: (inout Secretary_V1_Document) -> Void) {
        guard editable else { return }
        var updated = document
        update(&updated)
        guard updated != document else { return }
        document = updated
        edits += 1
        persistCurrent()
        scheduleSave()
    }

    private func persistCurrent() {
        let snapshot = document
        let sequence = edits
        let previous = persistence
        persisting = true
        persistence = Task {
            await previous?.value
            do {
                let result = try await coordinator.edit(snapshot)
                stored = result
                if edits == sequence {
                    document = try DocumentRules.decode(result.snapshot)
                    storageFailed = false; persisting = false; error = nil
                }
            } catch {
                storageFailed = true
                self.error = error.localizedDescription
                if edits == sequence { persisting = false }
            }
        }
    }

    private func scheduleSave() {
        debounce?.cancel()
        debounce = Task {
            do { try await Task.sleep(for: .milliseconds(700)) } catch { return }
            debounce = nil
            await save()
        }
    }

    public func save(deleting: Bool = false) async {
        if deleting { self.deleting = true }
        defer { if deleting { self.deleting = false } }
        await persistence?.value
        guard !storageFailed, !saving, !replacing, session.credentials != nil else { return }
        guard deleting || stored.dirty || stored.pending != nil || stored.needsRefresh == true else { return }
        saving = true; error = nil
        do { try await coordinator.flush(deleting: deleting) }
        catch { handle(error) }
        await reload()
        saving = false
        await onChange?()
        if stored.dirty, stored.pending == nil, stored.conflict == nil, stored.archived != true, stored.deleted != true, error == nil, session.credentials != nil {
            scheduleSave()
        }
    }

    public func retryLocalStorage() async {
        persistCurrent()
        await persistence?.value
        if !storageFailed { await save() }
    }

    public func resume() async {
        await persistence?.value
        guard !saving, !storageFailed, !replacing else { return }
        if stored.pending != nil || stored.dirty || stored.needsRefresh == true { await save() }
        else {
            do { try await coordinator.refreshLive() } catch { handle(error) }
            await reload()
        }
    }

    public func review() async {
        await persistence?.value
        guard !storageFailed, !saving else { return }
        do { try await coordinator.reviewServer() } catch { handle(error) }
        await reload()
    }

    public func refreshAfterTodoMutation() async {
        await persistence?.value
        guard !saving, !storageFailed, !replacing, stored.pending == nil else { return }
        do { try await coordinator.refreshLive() } catch { handle(error) }
        await reload()
    }

    public func resolve(useServer: Bool) async {
        await persistence?.value
        guard !storageFailed, !saving else { return }
        do {
            try await coordinator.resolve(useServer: useServer)
            error = nil
            await reload()
            if !useServer { await save() }
        } catch { handle(error) }
    }

    public func reloadFromServer() async {
        guard !replacing, !saving else { return }
        replacing = true; reloading = true
        defer { replacing = false; reloading = false }
        debounce?.cancel(); debounce = nil
        await persistence?.value
        guard !storageFailed, !saving else { return }
        do { try await coordinator.reloadFromServer(); error = nil } catch { handle(error) }
        await reload()
        await onChange?()
    }

    public func archiveRecovery() async {
        replacing = true; defer { replacing = false }
        await persistence?.value
        guard !storageFailed, !saving else { return }
        do { try await coordinator.archiveRecovery(); error = nil } catch { handle(error) }
        await reload()
        await onChange?()
    }

    private func reload() async {
        let sequence = edits
        await persistence?.value
        do {
            let result = try await coordinator.record()
            stored = result
            if sequence == edits, !storageFailed { document = try DocumentRules.decode(result.snapshot) }
        } catch { handle(error) }
    }
    private func handle(_ error: Error) {
        self.error = error.localizedDescription
        if error is DatabaseError || error is DraftStorageError { storageFailed = true }
        if (error as? ConnectError)?.code == .unauthenticated { onAuthenticationFailure?() }
    }

    public func addBlock(after key: String? = nil) -> String {
        let newKey = UUID().uuidString.lowercased()
        change { document in
            var block = Secretary_V1_Block(); block.clientKey = newKey
            if let key, let index = document.blocks.firstIndex(where: { $0.clientKey == key }) {
                block.parentClientKey = document.blocks[index].parentClientKey
                let descendants = Self.subtree(document.blocks, key: key)
                let end = document.blocks.lastIndex(where: { descendants.contains($0.clientKey) }) ?? index
                document.blocks.insert(block, at: end + 1)
            } else { document.blocks.append(block) }
            Self.renumber(&document)
        }
        return newKey
    }

    public enum BlockAction { case delete, indent, outdent, up, down, cycleTodo }
    public func modifyBlock(_ key: String, action: BlockAction) {
        change { document in
            guard let index = document.blocks.firstIndex(where: { $0.clientKey == key }) else { return }
            let block = document.blocks[index]
            let subtree = Self.subtree(document.blocks, key: key)
            let siblings = document.blocks.filter { $0.parentClientKey == block.parentClientKey }
            guard let sibling = siblings.firstIndex(where: { $0.clientKey == key }) else { return }
            switch action {
            case .cycleTodo:
                document.blocks[index].todoStatus = switch block.todoStatus {
                case "": "todo"
                case "todo": "done"
                default: ""
                }
            case .delete:
                document.blocks.removeAll { subtree.contains($0.clientKey) }
            case .indent:
                guard sibling > 0 else { return }
                document.blocks[index].parentClientKey = siblings[sibling - 1].clientKey
                document.blocks[index].parentBlockID = 0
            case .outdent:
                guard let parent = document.blocks.first(where: { $0.clientKey == block.parentClientKey }) else { return }
                var moving = document.blocks.filter { subtree.contains($0.clientKey) }
                moving[0].parentClientKey = parent.parentClientKey; moving[0].parentBlockID = 0
                let parentTree = Self.subtree(document.blocks, key: parent.clientKey)
                document.blocks.removeAll { subtree.contains($0.clientKey) }
                let destination = document.blocks.lastIndex(where: { parentTree.contains($0.clientKey) }) ?? 0
                document.blocks.insert(contentsOf: moving, at: destination + 1)
            case .up, .down:
                let target = action == .up ? sibling - 1 : sibling + 1
                guard siblings.indices.contains(target) else { return }
                let targetTree = Self.subtree(document.blocks, key: siblings[target].clientKey)
                let moving = document.blocks.filter { subtree.contains($0.clientKey) }
                document.blocks.removeAll { subtree.contains($0.clientKey) }
                let destination = action == .up
                    ? document.blocks.firstIndex(where: { targetTree.contains($0.clientKey) })!
                    : document.blocks.lastIndex(where: { targetTree.contains($0.clientKey) })! + 1
                document.blocks.insert(contentsOf: moving, at: destination)
            }
            Self.renumber(&document)
        }
    }
    public func depth(of key: String) -> Int {
        var parent = document.blocks.first(where: { $0.clientKey == key })?.parentClientKey ?? ""
        var seen: Set<String> = []; var depth = 0
        while !parent.isEmpty, seen.insert(parent).inserted {
            depth += 1
            parent = document.blocks.first(where: { $0.clientKey == parent })?.parentClientKey ?? ""
        }
        return depth
    }
    private static func subtree(_ blocks: [Secretary_V1_Block], key: String) -> Set<String> {
        var found: Set<String> = [key]; var queue = [key]
        while let parent = queue.popLast() {
            for block in blocks where block.parentClientKey == parent {
                if found.insert(block.clientKey).inserted { queue.append(block.clientKey) }
            }
        }
        return found
    }
    private static func renumber(_ document: inout Secretary_V1_Document) {
        for index in document.blocks.indices { document.blocks[index].sortOrder = Int32(index + 1) }
    }
}

public struct RecoveryNote: Identifiable {
    public let id: String
    public let title: String
    public let kind: String
    public let journalDate: String
}

@MainActor @Observable
public final class EditorLibrary {
    public let session = MutationSession()
    public private(set) var recovery: [RecoveryNote] = []
    private let store: DraftRepository
    private let api: any DocumentAPI
    private var editors: [String: DocumentEditor] = [:]
    private var scope: AccountScope?
    @ObservationIgnored public var onChange: (() async -> Void)?
    @ObservationIgnored public var onAuthenticationFailure: (() -> Void)?

    public init(store: DraftRepository, api: any DocumentAPI = BackendAPI()) { self.store = store; self.api = api }
    public func activate(_ credentials: Credentials) {
        let next = AccountScope(backend: credentials.backend, userID: credentials.userID)
        if scope != next { editors = [:]; recovery = [] }
        scope = next; session.activate(credentials)
    }
    public func suspend() { session.suspend() }
    public func refreshAfterTodoMutation() async {
        for editor in Array(editors.values) { await editor.refreshAfterTodoMutation() }
        try? await refreshRecovery()
    }
    public func clear() { suspend(); scope = nil; editors = [:]; recovery = [] }

    public func refreshRecovery() async throws {
        guard let scope else { return }
        let records = try await store.allDrafts(scope: scope)
        guard self.scope == scope else { return }
        recovery = try records.compactMap { key, record in
            guard record.deleted != true, record.archived != true, record.dirty || record.pending != nil || record.conflict != nil || record.needsRefresh == true else { return nil }
            let document = try DocumentRules.decode(record.snapshot)
            return RecoveryNote(id: key, title: document.title.isEmpty ? "Untitled draft" : document.title,
                kind: document.kind, journalDate: document.journalDate)
        }.sorted { $0.title < $1.title }
    }

    public func resume() async {
        do {
            try await refreshRecovery()
            let keys = recovery.map(\.id)
            for key in keys {
                guard session.credentials != nil else { break }
                let editor = try await open(key: key)
                await editor.resume()
            }
        } catch { /* Per-document errors remain visible when opening recovery. */ }
    }

    public func open(id: Int64? = nil, key: String? = nil) async throws -> DocumentEditor {
        guard let scope else { throw DocumentEditError.unavailable }
        let ticket = try session.ticket(scope: scope)
        let records = try await store.allDrafts(scope: scope)
        let retainedKey = try key ?? records.first(where: {
            guard $0.value.archived != true, $0.value.deleted != true else { return false }
            return try DocumentRules.decode($0.value.snapshot).id == id
        })?.key
        var draftKey = retainedKey ?? "document:\(id ?? 0)"
        if retainedKey == nil {
            while records[draftKey] != nil { draftKey += ":reopened" }
        }
        guard session.current(ticket) else { throw DocumentEditError.unavailable }
        if let existing = editors[draftKey] { return existing }
        let coordinator = DocumentCoordinator(key: draftKey, scope: scope, store: store, api: api, session: session)
        let record: StoredDraft
        if let retained = records[draftKey] { record = retained }
        else {
            guard let id else { throw DocumentEditError.missingDraft }
            let live: Secretary_V1_Document
            var cached = false
            do { live = try await api.document(ticket.credentials, id: id) }
            catch {
                // Authorization/deletion failures must never resurrect a cached document.
                if let code = (error as? ConnectError)?.code, [.unauthenticated, .permissionDenied, .notFound].contains(code) { throw error }
                guard let data = try await store.cached(scope: scope, key: "body:\(id)") else { throw error }
                live = try DocumentRules.decode(data); cached = true
            }
            guard session.current(ticket), live.id == id else { throw DocumentEditError.unavailable }
            let initialized = try await coordinator.initialize(live, existing: true)
            if cached {
                record = try await store.transition(scope: scope, key: draftKey) { previous in
                    var next = previous ?? initialized; next.needsRefresh = true; return next
                }
            } else { record = initialized }
        }
        guard session.current(ticket) else { throw DocumentEditError.unavailable }
        // A concurrent navigation/recovery load may have installed the editor during the read.
        if let existing = editors[draftKey] { return existing }
        return try install(coordinator, record: record)
    }

    public func openJournal(date: String, existingID: Int64? = nil, now: Date = Date()) async throws -> DocumentEditor {
        guard let scope, JournalDates.date(date) != nil else { throw DocumentEditError.invalidSnapshot }
        let ticket = try session.ticket(scope: scope)
        let records = try await store.allDrafts(scope: scope)
        guard session.current(ticket) else { throw DocumentEditError.unavailable }
        if let retained = try records.first(where: {
            guard $0.value.archived != true, $0.value.deleted != true else { return false }
            let document = try DocumentRules.decode($0.value.snapshot)
            return document.kind == "journal" && document.journalDate == date
        }) {
            return try await open(key: retained.key)
        }
        if let existingID { return try await open(id: existingID) }
        guard date <= (JournalDates.available(now: now).last ?? JournalDates.key(now)) else {
            throw DocumentEditError.unavailable
        }
        var key = "journal:\(date)"
        while records[key] != nil { key += ":reopened" }
        if let editor = editors[key] { return editor }
        var document = Secretary_V1_Document()
        document.workspaceID = scope.workspaceID; document.kind = "journal"
        document.clientKey = UUID().uuidString.lowercased()
        document.journalDate = date; document.title = date
        let coordinator = DocumentCoordinator(key: key, scope: scope, store: store, api: api, session: session)
        let record = try await coordinator.initialize(document, existing: false)
        guard session.current(ticket) else { throw DocumentEditError.unavailable }
        if let editor = editors[key] { return editor }
        let editor = try install(coordinator, record: record)
        try await refreshRecovery()
        return editor
    }

    public func create(parent: Int64, copy: DocumentEditor? = nil) async throws -> DocumentEditor {
        guard let scope else { throw DocumentEditError.unavailable }
        let ticket = try session.ticket(scope: scope)
        if let copy, copy.stored.pending != nil && copy.stored.rejected != true { throw DocumentEditError.unresolved }
        var document = copy?.document ?? Secretary_V1_Document()
        document.id = 0; document.clientKey = UUID().uuidString.lowercased(); document.revision = 0
        document.workspaceID = scope.workspaceID; document.kind = "note"; document.journalDate = ""
        document.directoryID = parent
        document.title = copy == nil ? "Untitled" : "\(document.title) (recovery copy)"
        let keys = Dictionary(uniqueKeysWithValues: document.blocks.map { ($0.clientKey, UUID().uuidString.lowercased()) })
        for index in document.blocks.indices {
            document.blocks[index].id = 0; document.blocks[index].todoID = 0; document.blocks[index].documentID = 0
            document.blocks[index].parentBlockID = 0
            document.blocks[index].parentClientKey = keys[document.blocks[index].parentClientKey] ?? ""
            document.blocks[index].clientKey = keys[document.blocks[index].clientKey]!
        }
        let coordinator = DocumentCoordinator(key: "local:\(document.clientKey)", scope: scope, store: store, api: api, session: session)
        let record = try await coordinator.initialize(document, existing: false)
        guard session.current(ticket) else { throw DocumentEditError.unavailable }
        let editor = try install(coordinator, record: record)
        try await refreshRecovery()
        return editor
    }

    private func install(_ coordinator: DocumentCoordinator, record: StoredDraft) throws -> DocumentEditor {
        let editor = try DocumentEditor(coordinator: coordinator, record: record, session: session)
        editor.onChange = { [weak self] in
            guard let self else { return }
            try? await self.refreshRecovery()
            await self.onChange?()
        }
        editor.onAuthenticationFailure = { [weak self] in self?.onAuthenticationFailure?() }
        editors[editor.id] = editor
        return editor
    }
}
