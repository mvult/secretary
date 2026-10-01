import Connect
import Foundation
import SecretaryCore
import SwiftProtobuf
import Testing

private actor TodoServer: TodosAPI {
    var items: [Secretary_V1_Todo] = []
    var requests: [PendingOperation] = []
    var receipts: [String: Data] = [:]
    var loseResponse = false
    var rejected = false
    var admin = false
    func loseNext() { loseResponse = true }
    func rejectNext() { rejected = true }
    func setAdmin() { admin = true }
    func todos(_ credentials: Credentials) async throws -> [Secretary_V1_Todo] { items.filter { $0.userID == credentials.userID } }
    func canDeleteTodos(_ credentials: Credentials) async throws -> Bool { admin }
    func sendRetained(_ operation: PendingOperation, credentials: Credentials) async throws -> Data {
        requests.append(operation)
        if let receipt = receipts[operation.mutationID] { return receipt }
        if rejected { rejected = false; throw ConnectError(code: .invalidArgument, message: "Rejected") }
        let data: Data
        switch operation.kind {
        case .createTodo:
            let request = try Secretary_V1_CreateTodoRequest(jsonUTF8Data: operation.requestBytes)
            var todo = Secretary_V1_Todo(); todo.id = Int64(items.count + 1); todo.userID = request.userID
            todo.name = request.name; todo.desc = request.desc; todo.status = request.status
            items.append(todo)
            var response = Secretary_V1_CreateTodoResponse(); response.todo = todo; response.mutationID = operation.mutationID
            data = try response.jsonUTF8Data()
        case .updateTodo:
            let request = try Secretary_V1_UpdateTodoRequest(jsonUTF8Data: operation.requestBytes)
            let index = items.firstIndex { $0.id == request.id }!
            if request.patch.hasName { items[index].name = request.patch.name }
            if request.patch.hasDesc { items[index].desc = request.patch.desc }
            if request.patch.hasStatus { items[index].status = request.patch.status }
            var response = Secretary_V1_UpdateTodoResponse(); response.todo = items[index]; response.mutationID = operation.mutationID
            data = try response.jsonUTF8Data()
        case .deleteTodo:
            let request = try Secretary_V1_DeleteTodoRequest(jsonUTF8Data: operation.requestBytes)
            items.removeAll { $0.id == request.id }
            var response = Secretary_V1_DeleteTodoResponse(); response.mutationID = operation.mutationID
            data = try response.jsonUTF8Data()
        default: throw DocumentEditError.invalidSnapshot
        }
        receipts[operation.mutationID] = data
        if loseResponse { loseResponse = false; throw URLError(.networkConnectionLost) }
        return data
    }
}

@MainActor @Test func todoLostCreateResponseSurvivesRestartWithoutDuplicate() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("todos-\(UUID()).sqlite")
    defer { try? FileManager.default.removeItem(at: path) }
    let credentials = Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: 1)
    let server = TodoServer()
    let model = TodosModel(store: try DraftRepository(path: path.path), api: server)
    model.activate(credentials)
    #expect(!model.canMutate)
    await model.refresh()
    await server.loseNext()
    #expect(await model.save(original: nil, name: "Retained", description: "Details", status: .todo) == false)
    #expect(model.pending.count == 1 && !model.canMutate)
    let reopened = TodosModel(store: try DraftRepository(path: path.path), api: server)
    reopened.activate(credentials); await reopened.refresh()
    #expect(await reopened.retry(reopened.pending[0]))
    #expect(reopened.pending.isEmpty && reopened.items.count == 1)
    let requests = await server.requests
    #expect(requests.count == 2 && requests[0].requestBytes == requests[1].requestBytes)
    let other = Credentials(backend: credentials.backend, token: "other", userID: 2)
    reopened.activate(other); await reopened.refresh()
    #expect(reopened.items.isEmpty && reopened.pending.isEmpty)
    #expect(await reopened.retry(requests[0]) == false)
}

@MainActor @Test func todoPatchesPreserveOmittedFieldsAndDeletionRequiresPermission() async throws {
    let credentials = Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: 1)
    let server = TodoServer()
    let model = TodosModel(store: try DraftRepository(path: ":memory:"), api: server)
    model.activate(credentials); await model.refresh()
    #expect(await model.save(original: nil, name: "Original", description: "Clear me", status: .todo))
    let original = model.items[0]
    #expect(await model.save(original: original, name: original.name, description: "", status: .blocked))
    let update = try Secretary_V1_UpdateTodoRequest(jsonUTF8Data: await server.requests.last!.requestBytes)
    #expect(!update.patch.hasName && update.patch.hasDesc && update.patch.desc.isEmpty && update.patch.hasStatus)
    #expect(!update.patch.hasBucket && !update.patch.hasGoalID && update.workspaceID == 0)
    model.filter = .blocked; #expect(model.visible.count == 1)
    model.filter = .open; #expect(model.visible.isEmpty)
    #expect(await model.delete(model.items[0]) == false)
    await server.setAdmin(); await model.refresh()
    #expect(await model.delete(model.items[0]))
    #expect(model.items.isEmpty)
}

@MainActor @Test func rejectedTodoCommandStaysRejectedAcrossRefreshAndCacheInvalidation() async throws {
    let credentials = Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: 1)
    let scope = AccountScope(backend: credentials.backend, userID: 1)
    let server = TodoServer(); let store = try DraftRepository(path: ":memory:")
    let model = TodosModel(store: store, api: server)
    model.activate(credentials); await model.refresh()
    await server.rejectNext()
    #expect(await model.save(original: nil, name: "Rejected", description: "", status: .todo) == false)
    let operation = model.pending[0]
    _ = try await store.transition(scope: scope, key: "irrelevant", invalidateCache: true) { _ in StoredDraft(snapshot: Data(), baseline: nil) }
    let reopened = TodosModel(store: store, api: server)
    reopened.activate(credentials); await reopened.refresh()
    #expect(reopened.rejected.contains(operation.mutationID))
    #expect(await reopened.retry(operation) == false)
    await reopened.discardRejected(operation)
    #expect(reopened.pending.isEmpty && reopened.canMutate)
    #expect(await server.requests.count == 1)
}

@MainActor @Test func todoMutationRefreshPreservesDirtyDocumentAsConflict() async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(sampleDocument())
    let coordinator = DocumentCoordinator(key: "note", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    let record = try await coordinator.initialize(sampleDocument(), existing: true)
    let editor = try DocumentEditor(coordinator: coordinator, record: record, session: session)
    session.suspend()
    editor.change { $0.blocks[0].text = "Unsaved local work" }
    await editor.save()
    session.activate(Credentials(backend: scope.backend, token: "token", userID: scope.userID))
    await server.changeRemote()
    await editor.refreshAfterTodoMutation()
    #expect(editor.document.blocks[0].text == "Unsaved local work")
    #expect(editor.stored.conflict != nil && editor.stored.dirty)
    #expect(try DocumentRules.decode(editor.stored.serverCopy!).title == "Changed elsewhere")
    #expect(await server.requests.isEmpty)
    session.suspend()
}

private func sampleDocument(new: Bool = false) -> Secretary_V1_Document {
    var document = Secretary_V1_Document()
    document.id = new ? 0 : 10; document.clientKey = "document-key"; document.workspaceID = 4
    document.kind = "note"; document.title = "Original"; document.revision = new ? 0 : 1
    var block = Secretary_V1_Block()
    block.id = new ? 0 : 100; block.clientKey = "block-key"; block.text = "First"; block.sortOrder = 1
    document.blocks = [block]
    return document
}

@Test func journalAvailabilityUsesLocalCalendarAndFridayCutoff() throws {
    let calendar = JournalDates.calendar(timeZone: TimeZone(identifier: "America/New_York")!)
    func at(_ day: String, hour: Int) -> Date {
        calendar.date(bySettingHour: hour, minute: 0, second: 0, of: JournalDates.date(day, calendar: calendar)!)!
    }
    #expect(JournalDates.available(now: at("2026-10-02", hour: 17), calendar: calendar) == ["2026-10-02"])
    #expect(JournalDates.available(now: at("2026-10-02", hour: 18), calendar: calendar) == ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"])
    #expect(JournalDates.available(now: at("2026-12-31", hour: 18), calendar: calendar) == ["2026-12-31", "2027-01-01"])
    #expect(JournalDates.available(now: at("2026-03-07", hour: 18), calendar: calendar) == ["2026-03-07", "2026-03-08"])
    #expect(JournalDates.date("2026-02-30") == nil)
}

@MainActor @Test func journalOpeningSharesDraftAndRecoversAcrossLibraryRestart() async throws {
    let credentials = Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: 1)
    let store = try DraftRepository(path: ":memory:")
    let server = DocumentServer(nil)
    let library = EditorLibrary(store: store, api: server)
    library.activate(credentials)
    async let first = library.openJournal(date: "2026-01-01")
    async let second = library.openJournal(date: "2026-01-01")
    let (editor, other) = try await (first, second)
    #expect(editor === other)
    #expect(editor.document.kind == "journal" && editor.document.directoryID == 0)
    await server.loseNextResponse()
    await editor.save()
    #expect(editor.stored.pending != nil)
    library.suspend()
    let reopened = EditorLibrary(store: store, api: server)
    reopened.activate(credentials)
    let recovered = try await reopened.openJournal(date: "2026-01-01")
    await recovered.resume()
    #expect(recovered.document.id > 0 && recovered.stored.pending == nil)
    let requests = await server.requests
    #expect(requests.count == 2 && requests[0].requestBytes == requests[1].requestBytes)
    await #expect(throws: DocumentEditError.self) {
        try await reopened.openJournal(date: "2099-01-01")
    }
}

private actor DocumentServer: DocumentAPI {
    var live: Secretary_V1_Document?
    var requests: [PendingOperation] = []
    var receipts: [String: Data] = [:]
    var loseResponse = false
    var paused = false
    var corruptAcknowledgment = false
    var existingJournal: Secretary_V1_Document?
    private var continuation: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    init(_ document: Secretary_V1_Document?) { live = document }
    func loseNextResponse() { loseResponse = true }
    func corruptNextAcknowledgment() { corruptAcknowledgment = true }
    func pause() { paused = true }
    func waitForSend() async {
        if continuation != nil { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func finish() { paused = false; continuation?.resume(); continuation = nil }
    func removeDocument() { live = nil }
    func changeRemote() { live?.revision += 1; live?.title = "Changed elsewhere" }
    func useExistingJournal(_ document: Secretary_V1_Document) { existingJournal = document; live = document }
    func document(_ credentials: Credentials, id: Int64) async throws -> Secretary_V1_Document {
        guard let live, live.id == id else { throw ConnectError(code: .notFound, message: "Deleted") }
        return live
    }
    func sendRetained(_ operation: PendingOperation, credentials: Credentials) async throws -> Data {
        requests.append(operation)
        if paused {
            await withCheckedContinuation {
                continuation = $0; waiter?.resume(); waiter = nil
            }
        }
        if let receipt = receipts[operation.mutationID] { return receipt }
        let response: Data
        if operation.kind == .deleteDocument {
            let request = try Secretary_V1_DeleteDocumentRequest(jsonUTF8Data: operation.requestBytes)
            guard live?.revision == request.expectedRevision else { throw ConnectError(code: .aborted, message: "Revision conflict") }
            live = nil
            var result = Secretary_V1_DeleteDocumentResponse(); result.mutationID = request.mutationID
            result.effects.deletedDocumentIds = [request.id]
            response = try result.jsonUTF8Data()
        } else {
            let request = try Secretary_V1_SaveDocumentRequest(jsonUTF8Data: operation.requestBytes)
            var result = Secretary_V1_SaveDocumentResponse(); result.mutationID = request.mutationID
            if let existingJournal {
                result.document = existingJournal; result.outcome = .existingJournal
            } else {
                guard (live?.revision ?? 0) == request.expectedRevision else { throw ConnectError(code: .aborted, message: "Revision conflict") }
                var saved = request.document
                saved.id = 10; saved.revision = request.expectedRevision + 1
                var nextID: Int64 = 100
                for index in saved.blocks.indices {
                    if saved.blocks[index].id == 0 {
                        while saved.blocks.contains(where: { $0.id == nextID }) { nextID += 1 }
                        saved.blocks[index].id = nextID; nextID += 1
                    }
                    saved.blocks[index].documentID = saved.id
                }
                let ids = Dictionary(uniqueKeysWithValues: saved.blocks.map { ($0.clientKey, $0.id) })
                for index in saved.blocks.indices { saved.blocks[index].parentBlockID = ids[saved.blocks[index].parentClientKey] ?? 0 }
                result.document = saved; result.outcome = .applied; live = saved
            }
            response = try result.jsonUTF8Data()
        }
        receipts[operation.mutationID] = response
        if loseResponse { loseResponse = false; throw URLError(.networkConnectionLost) }
        if corruptAcknowledgment {
            corruptAcknowledgment = false
            var broken = try Secretary_V1_SaveDocumentResponse(jsonUTF8Data: response)
            broken.mutationID = UUID().uuidString
            return try broken.jsonUTF8Data()
        }
        return response
    }
}

@MainActor private func testSession(user: Int64 = 1) throws -> (MutationSession, AccountScope) {
    let credentials = Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: user)
    let session = MutationSession(); session.activate(credentials)
    return (session, AccountScope(backend: credentials.backend, userID: user))
}

@MainActor @Test func lostResponseRestartReplaysExactBytesBeforeNewerEdits() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("save-\(UUID()).sqlite")
    defer { try? FileManager.default.removeItem(at: path) }
    let store = try DraftRepository(path: path.path)
    let (session, scope) = try testSession()
    let server = DocumentServer(sampleDocument())
    let first = DocumentCoordinator(key: "document", scope: scope, store: store, api: server, session: session)
    _ = try await first.initialize(sampleDocument(), existing: true)
    var edited = sampleDocument(); edited.blocks[0].text = "Submitted"
    _ = try await first.edit(edited)
    await server.loseNextResponse()
    await #expect(throws: URLError.self) { try await first.flush() }
    let retained = try await first.record()
    #expect(retained.pending != nil)
    await #expect(throws: DocumentEditError.self) { try await first.reloadFromServer() }
    await #expect(throws: DocumentEditError.self) { try await first.archiveRecovery() }
    edited.blocks[0].text = "Typed after lost response"
    _ = try await first.edit(edited)
    let reopened = DocumentCoordinator(key: "document", scope: scope, store: try DraftRepository(path: path.path), api: server, session: session)
    try await reopened.flush()
    let requests = await server.requests
    #expect(requests.count == 3)
    #expect(requests[0].requestBytes == requests[1].requestBytes)
    #expect(requests[0].mutationID == requests[1].mutationID)
    #expect(requests[2].mutationID != requests[1].mutationID)
    let final = try await reopened.record()
    #expect(!final.dirty && final.pending == nil && final.needsRefresh == false)
    #expect(try DocumentRules.decode(final.snapshot).blocks[0].text == "Typed after lost response")
    #expect(await server.live?.revision == 3)
}

@MainActor @Test func inFlightCreateMapsIdentitiesWithoutReplacingNewEdits() async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(nil)
    let coordinator = DocumentCoordinator(key: "new", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    _ = try await coordinator.initialize(sampleDocument(new: true), existing: false)
    await server.pause()
    let send = Task { try await coordinator.flush() }
    await server.waitForSend()
    var latest = sampleDocument(new: true); latest.blocks[0].text = "Edited in flight"
    var child = Secretary_V1_Block(); child.clientKey = "child"; child.parentClientKey = "block-key"; child.sortOrder = 2; child.text = "Child"
    latest.blocks.append(child)
    _ = try await coordinator.edit(latest)
    await server.finish()
    try await send.value
    let record = try await coordinator.record()
    let saved = try DocumentRules.decode(record.snapshot)
    #expect(!record.dirty && record.pending == nil)
    #expect(saved.blocks[0].text == "Edited in flight")
    #expect(saved.blocks.allSatisfy { $0.id > 0 })
    #expect(saved.blocks[1].parentBlockID == saved.blocks[0].id)
    let requests = await server.requests
    #expect(requests.count == 2)
    let next = try Secretary_V1_SaveDocumentRequest(jsonUTF8Data: requests[1].requestBytes)
    #expect(next.document.id == 10 && next.expectedRevision == 1)
    #expect(next.document.blocks[0].id > 0 && next.document.blocks[1].id == 0)
}

@MainActor @Test func historicalReceiptAfterDeletionRetainsDraftWithoutResurrection() async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(sampleDocument())
    let coordinator = DocumentCoordinator(key: "note", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    _ = try await coordinator.initialize(sampleDocument(), existing: true)
    var edit = sampleDocument(); edit.title = "Local title"
    _ = try await coordinator.edit(edit)
    await server.loseNextResponse()
    await #expect(throws: URLError.self) { try await coordinator.flush() }
    await server.removeDocument()
    edit.title = "Keep this work"
    _ = try await coordinator.edit(edit)
    try await coordinator.flush()
    let record = try await coordinator.record()
    #expect(record.conflict != nil && record.serverMissing == true && record.dirty)
    #expect(try DocumentRules.decode(record.snapshot).title == "Keep this work")
    #expect(await server.requests.count == 2)
}

@MainActor @Test func revisionConflictRequiresExplicitReviewedResolution() async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(sampleDocument())
    let coordinator = DocumentCoordinator(key: "note", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    _ = try await coordinator.initialize(sampleDocument(), existing: true)
    var edit = sampleDocument(); edit.title = "Local title"
    _ = try await coordinator.edit(edit)
    await server.changeRemote()
    await #expect(throws: ConnectError.self) { try await coordinator.flush() }
    let conflict = try await coordinator.record()
    #expect(conflict.rejected == true && conflict.pending != nil && conflict.conflict != nil)
    #expect(try DocumentRules.decode(conflict.serverCopy!).title == "Changed elsewhere")
    try await coordinator.flush()
    #expect(await server.requests.count == 1)
    try await coordinator.resolve(useServer: false)
    try await coordinator.flush()
    #expect(await server.live?.title == "Local title")
    #expect(await server.live?.revision == 3)
}

@MainActor @Test func logoutDuringSaveLeavesRequestRetainedUntilOriginalAccountReturns() async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(nil)
    let coordinator = DocumentCoordinator(key: "new", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    _ = try await coordinator.initialize(sampleDocument(new: true), existing: false)
    await server.pause()
    let send = Task { try await coordinator.flush() }
    await server.waitForSend()
    session.suspend()
    session.activate(Credentials(backend: scope.backend, token: "different-account", userID: 2))
    await server.finish()
    try await send.value
    #expect(try await coordinator.record().pending != nil)
    await #expect(throws: DocumentEditError.self) { try await coordinator.flush() }
    #expect(await server.requests.count == 1)
    session.activate(Credentials(backend: scope.backend, token: "token", userID: 1))
    try await coordinator.flush()
    #expect(try await coordinator.record().pending == nil)
    #expect(await server.requests.count == 2)
}

@MainActor @Test func lostDeleteResponseReplaysAndInvalidatesCache() async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(sampleDocument())
    let store = try DraftRepository(path: ":memory:")
    let coordinator = DocumentCoordinator(key: "note", scope: scope, store: store, api: server, session: session)
    _ = try await coordinator.initialize(sampleDocument(), existing: true)
    try await store.cache(scope: scope, key: "index", data: Data("stale".utf8))
    await server.loseNextResponse()
    await #expect(throws: URLError.self) { try await coordinator.flush(deleting: true) }
    await #expect(throws: DocumentEditError.self) { try await coordinator.edit(sampleDocument()) }
    try await coordinator.flush()
    #expect(try await coordinator.record().deleted == true)
    #expect(try await store.cached(scope: scope, key: "index") == nil)
    let requests = await server.requests
    #expect(requests[0].requestBytes == requests[1].requestBytes)
}

@MainActor @Test(arguments: [false, true]) func journalCreateRaceAdoptsOnlyUntouchedDraft(edited: Bool) async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(nil)
    var draft = sampleDocument(new: true); draft.kind = "journal"; draft.journalDate = "2026-09-30"; draft.title = ""; draft.blocks = []
    var existing = sampleDocument(); existing.kind = "journal"; existing.journalDate = draft.journalDate; existing.clientKey = "other-journal"
    await server.useExistingJournal(existing)
    let coordinator = DocumentCoordinator(key: "journal", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    _ = try await coordinator.initialize(draft, existing: false)
    if edited { draft.title = "Local journal title"; _ = try await coordinator.edit(draft) }
    try await coordinator.flush()
    let record = try await coordinator.record()
    #expect((record.conflict != nil) == edited)
    if edited { #expect(try DocumentRules.decode(record.snapshot).title == "Local journal title") }
    else { #expect(try DocumentRules.decode(record.snapshot).clientKey == "other-journal") }
}

@MainActor @Test func crashBeforeFirstSendUsesCommittedEnvelope() async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(nil)
    let store = try DraftRepository(path: ":memory:")
    let coordinator = DocumentCoordinator(key: "new", scope: scope, store: store, api: server, session: session)
    let draft = try await coordinator.initialize(sampleDocument(new: true), existing: false)
    let pending = try DocumentRules.prepare(draft, scope: scope)
    _ = try await store.prepare(scope: scope, key: "new", operation: pending, expectedLocalVersion: draft.localVersion)
    let replacement = DocumentCoordinator(key: "new", scope: scope, store: store, api: server, session: session)
    try await replacement.flush()
    #expect(await server.requests.first?.requestBytes == pending.requestBytes)
    #expect(try await replacement.record().pending == nil)
}

@MainActor @Test func blockTreeEditsKeepSubtreesAndPersistLocally() async throws {
    let (session, scope) = try testSession()
    defer { session.suspend() }
    let server = DocumentServer(nil)
    let coordinator = DocumentCoordinator(key: "new", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    let record = try await coordinator.initialize(sampleDocument(new: true), existing: false)
    let editor = try DocumentEditor(coordinator: coordinator, record: record, session: session)
    session.suspend() // Editing remains locally durable without a network session.
    let child = editor.addBlock()
    editor.modifyBlock(child, action: .indent)
    #expect(editor.document.blocks[1].parentClientKey == "block-key")
    let sibling = editor.addBlock(after: "block-key")
    editor.modifyBlock(sibling, action: .up)
    #expect(editor.document.blocks.map(\.clientKey) == [sibling, "block-key", child])
    editor.modifyBlock(child, action: .outdent)
    #expect(editor.document.blocks.last?.parentClientKey == "")
    editor.modifyBlock(child, action: .indent)
    editor.modifyBlock("block-key", action: .delete)
    #expect(editor.document.blocks.map(\.clientKey) == [sibling])
    await editor.save() // Drains the immediate local-write queue; sending is paused.
    #expect(try DocumentRules.decode(await coordinator.record().snapshot).blocks.map(\.clientKey) == [sibling])
    #expect(await server.requests.isEmpty)
}

@MainActor @Test func failedLocalPersistenceKeepsMemoryAndStopsNetwork() async throws {
    let (session, scope) = try testSession()
    defer { session.suspend() }
    let server = DocumentServer(sampleDocument())
    let coordinator = DocumentCoordinator(key: "note", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    let record = try await coordinator.initialize(sampleDocument(), existing: true)
    let editor = try DocumentEditor(coordinator: coordinator, record: record, session: session)
    editor.change { document in
        document.title = "Keep in memory"
        document.blocks[0].parentClientKey = "missing-parent"
    }
    await editor.save()
    #expect(editor.storageFailed)
    #expect(editor.document.title == "Keep in memory")
    #expect(await server.requests.isEmpty)
    #expect(try DocumentRules.decode(await coordinator.record().snapshot).title == "Original")
    editor.change { $0.blocks[0].parentClientKey = "" }
    await editor.retryLocalStorage()
    #expect(!editor.storageFailed)
    #expect(await server.live?.title == "Keep in memory")
}

#if os(iOS)
/// Explicitly enabled by the Xcode build setting SECRETARY_LIVE_SMOKE=1.
/// Uses the signed-in simulator account; only mutates its own uniquely named note.
@MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["SECRETARY_LIVE_SMOKE"] == "1"))
func liveNoteCreateEditMoveDelete() async throws {
    let credentials = try #require(try KeychainCredentials().load(), "Sign in to the simulator app first")
    let api = BackendAPI()
    let validated = try await api.validate(credentials)
    let session = MutationSession(); session.activate(credentials)
    let store = try DraftRepository.applicationStore()
    var document = sampleDocument(new: true)
    document.clientKey = UUID().uuidString.lowercased()
    document.blocks[0].clientKey = UUID().uuidString.lowercased()
    document.title = "iOS editor smoke \(document.clientKey)"
    let coordinator = DocumentCoordinator(key: "smoke:\(document.clientKey)", scope: validated.scope,
        store: store, api: api, session: session)
    _ = try await coordinator.initialize(document, existing: false)
    try await coordinator.flush()
    let created = try DocumentRules.decode(await coordinator.record().snapshot)
    #expect(created.id > 0 && created.revision == 1)
    #expect(created.blocks[0].id > 0)
    var updated = created
    updated.title += " · renamed"
    updated.blocks[0].text = "# Updated heading"
    var child = Secretary_V1_Block(); child.clientKey = UUID().uuidString.lowercased()
    child.parentClientKey = updated.blocks[0].clientKey; child.text = "Nested child"; child.sortOrder = 2
    updated.blocks.append(child)
    let index = try await api.index(credentials, before: 0)
    updated.directoryID = index.directories.first?.id ?? 0
    _ = try await coordinator.edit(updated)
    try await coordinator.flush()
    let fetched = try await api.document(credentials, id: created.id)
    #expect(fetched.title == updated.title && fetched.directoryID == updated.directoryID)
    #expect(fetched.blocks.count == 2)
    #expect(fetched.blocks.first(where: { $0.clientKey == child.clientKey })?.parentBlockID == created.blocks[0].id)
    try await coordinator.flush(deleting: true)
    #expect(try await coordinator.record().deleted == true)
    do {
        _ = try await api.document(credentials, id: created.id)
        Issue.record("Deleted smoke note remains readable")
    } catch let error as ConnectError { #expect(error.code == .notFound) }
}
#endif

@MainActor @Test func malformedAcknowledgmentCannotClearRetainedRequest() async throws {
    let (session, scope) = try testSession()
    let server = DocumentServer(nil)
    let coordinator = DocumentCoordinator(key: "new", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    _ = try await coordinator.initialize(sampleDocument(new: true), existing: false)
    await server.corruptNextAcknowledgment()
    await #expect(throws: DocumentEditError.self) { try await coordinator.flush() }
    #expect(try await coordinator.record().pending != nil)
    try await coordinator.flush()
    #expect(try await coordinator.record().pending == nil)
    let requests = await server.requests
    #expect(requests.count == 2 && requests[0].requestBytes == requests[1].requestBytes)
}

@MainActor @Test func concurrentOpenSharesOneEditorAndSaveQueue() async throws {
    let credentials = Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: 1)
    let library = EditorLibrary(store: try DraftRepository(path: ":memory:"), api: DocumentServer(sampleDocument()))
    library.activate(credentials)
    async let first = library.open(id: 10)
    async let second = library.open(id: 10)
    let editors = try await (first, second)
    #expect(editors.0 === editors.1)
}

@MainActor @Test func unchangedBindingsAndNoOpBlockActionsDoNotSave() async throws {
    let (session, scope) = try testSession()
    defer { session.suspend() }
    let server = DocumentServer(sampleDocument())
    let coordinator = DocumentCoordinator(key: "note", scope: scope, store: try DraftRepository(path: ":memory:"), api: server, session: session)
    let record = try await coordinator.initialize(sampleDocument(), existing: true)
    let editor = try DocumentEditor(coordinator: coordinator, record: record, session: session)
    editor.change { $0.title = "Original" }
    editor.change { $0.blocks[0].text = "First" }
    editor.modifyBlock("block-key", action: .indent)
    editor.modifyBlock("block-key", action: .outdent)
    editor.modifyBlock("block-key", action: .up)
    await editor.save()
    #expect(!editor.persisting && !editor.saving)
    #expect(try await coordinator.record() == record)
    #expect(await server.requests.isEmpty)
}
