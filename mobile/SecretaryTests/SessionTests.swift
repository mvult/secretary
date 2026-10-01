import Connect
import Foundation
import SecretaryCore
import Testing
import SwiftProtobuf

private actor NotesFixture: NotesAPI {
    var offline = false
    var failMutation = false
    var cursors: [Int64] = []
    var writes = 0
    private var pause = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    func pauseReads() { pause = true }
    func waitForRead() async {
        if continuation != nil { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func finishRead() { pause = false; continuation?.resume(); continuation = nil }
    private func waitIfPaused() async {
        guard pause else { return }
        await withCheckedContinuation {
            continuation = $0; waiter?.resume(); waiter = nil
        }
    }
    func setOffline() { offline = true }
    func setMutationFailure() { failMutation = true }
    func index(_ credentials: Credentials, before: Int64) async throws -> Secretary_V1_ListDocumentIndexResponse {
        await waitIfPaused()
        cursors.append(before)
        if offline { throw URLError(.notConnectedToInternet) }
        var result = Secretary_V1_ListDocumentIndexResponse(); result.persistenceProtocolVersion = 1
        var entry = Secretary_V1_DocumentIndexEntry()
        entry.id = before == 0 ? 10 : 5; entry.workspaceID = 4; entry.kind = "note"; entry.revision = 1
        result.entries = [entry]
        if before == 0 {
            result.nextBeforeID = 10
            var folder = Secretary_V1_Directory(); folder.id = 1; folder.workspaceID = 4; folder.name = "Folder"
            var child = folder; child.id = 2; child.parentID = 1
            result.directories = [folder, child]
        }
        return result
    }
    func document(_ credentials: Credentials, id: Int64) async throws -> Secretary_V1_Document {
        await waitIfPaused()
        if offline { throw URLError(.notConnectedToInternet) }
        var document = Secretary_V1_Document(); document.id = id; document.workspaceID = 4; document.revision = 1
        document.title = "Saved body"
        return document
    }
    func createDirectory(_ credentials: Credentials, name: String, parent: Int64) async throws {
        writes += 1
        if failMutation { throw URLError(.timedOut) }
    }
    func updateDirectory(_ credentials: Credentials, id: Int64, name: String?, parent: Int64?) async throws {}
    func deleteDirectory(_ credentials: Credentials, id: Int64) async throws {}
}

@MainActor @Test func paginatedNotesCacheSurvivesRestartAndStaysAccountScoped() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("notes-\(UUID()).sqlite")
    defer { try? FileManager.default.removeItem(at: path) }
    let store = try DraftRepository(path: path.path)
    let api = NotesFixture()
    let credentials = Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: 1)
    let model = NotesModel(api: api, store: store)
    model.activate(credentials)
    await model.refresh()
    #expect(await api.cursors == [0, 10])
    #expect(model.entries.map(\.id) == [10, 5])
    #expect(model.directories.count == 2)
    #expect(model.descendants(of: 1) == [1, 2])
    #expect(!model.canDelete(1))
    await model.open(10)
    #expect(model.body?.title == "Saved body")
    await api.setOffline()
    let reopened = NotesModel(api: api, store: try DraftRepository(path: path.path))
    reopened.activate(credentials)
    await reopened.refresh()
    await reopened.open(10)
    #expect(reopened.entries.map(\.id) == [10, 5])
    #expect(reopened.cachedIndex && reopened.cachedBody)
    #expect(reopened.body?.title == "Saved body")
    #expect(!reopened.canMutate)
    reopened.activate(Credentials(backend: credentials.backend, token: "other", userID: 2))
    await reopened.refresh()
    await reopened.open(10)
    #expect(reopened.entries.isEmpty)
    #expect(reopened.body == nil)
}

@MainActor @Test func ambiguousFolderFailureRequiresRefreshAndNeverAutomaticallyRetries() async throws {
    let api = NotesFixture()
    let model = NotesModel(api: api, store: try DraftRepository(path: ":memory:"))
    model.activate(Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: 1))
    await model.refresh()
    await api.setMutationFailure()
    #expect(await model.changeDirectory(.create(name: "Folder", parent: 0)) == false)
    #expect(!model.canMutate)
    #expect(await model.changeDirectory(.create(name: "Folder", parent: 0)) == false)
    #expect(await api.writes == 1)
    await model.refresh()
    #expect(model.canMutate)
}

@MainActor @Test(arguments: [false, true]) func signOutDiscardsLateNoteReads(body: Bool) async throws {
    let api = NotesFixture()
    let model = NotesModel(api: api, store: try DraftRepository(path: ":memory:"))
    model.activate(Credentials(backend: try BackendAddress("https://example.com"), token: "token", userID: 1))
    await api.pauseReads()
    let read = Task { if body { await model.open(10) } else { await model.refresh() } }
    await api.waitForRead()
    model.clear()
    await api.finishRead()
    await read.value
    #expect(model.entries.isEmpty && model.directories.isEmpty)
    #expect(model.body == nil)
    #expect(!model.enabled && !model.loading && !model.loadingBody)
}

@MainActor private final class MemoryCredentials: CredentialStore {
    var value: Credentials?
    func load() throws -> Credentials? { value }
    func save(_ credentials: Credentials) throws { value = credentials }
    func clear() throws { value = nil }
}

private struct SessionFixture: SessionAPI {
    let credentials: Credentials
    var validationError: ConnectError?
    func login(backend: BackendAddress, email: String, password: String) async throws -> Credentials { credentials }
    func validate(_ credentials: Credentials) async throws -> ValidatedSession {
        if let validationError { throw validationError }
        return ValidatedSession(scope: AccountScope(backend: credentials.backend, userID: credentials.userID),
            workspaceName: "Personal", protocolVersion: 1)
    }
}

private actor PausedSessionAPI: SessionAPI {
    let credentials: Credentials
    private var continuation: CheckedContinuation<Void, Never>?
    private var startedWaiter: CheckedContinuation<Void, Never>?

    init(credentials: Credentials) { self.credentials = credentials }
    func login(backend: BackendAddress, email: String, password: String) async throws -> Credentials { credentials }
    func validate(_ credentials: Credentials) async throws -> ValidatedSession {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            startedWaiter?.resume()
            startedWaiter = nil
        }
        return ValidatedSession(scope: AccountScope(backend: credentials.backend, userID: credentials.userID),
            workspaceName: "Personal", protocolVersion: 1)
    }
    func waitUntilStarted() async {
        if continuation != nil { return }
        await withCheckedContinuation { startedWaiter = $0 }
    }
    func finish() { continuation?.resume(); continuation = nil }
}

@MainActor @Test func logoutDuringValidationSuppressesLateResults() async throws {
    let backend = try BackendAddress("https://example.com")
    let credentials = Credentials(backend: backend, token: "token", userID: 1)
    let api = PausedSessionAPI(credentials: credentials)
    let keychain = MemoryCredentials()
    let defaults = try #require(UserDefaults(suiteName: "test.\(UUID())"))
    let model = SessionModel(api: api, credentials: keychain,
        drafts: try DraftRepository(path: ":memory:"), preferences: defaults)
    let login = Task { await model.login(backendURL: backend.rawValue, email: "user@example.com", password: "password") }
    await api.waitUntilStarted()
    model.logout()
    await api.finish()
    await login.value
    #expect(model.status == .signedOut)
    #expect(model.session == nil)
    #expect(keychain.value == nil)
}

@MainActor @Test func expiredSessionRetainsScopedRecoveryWithoutBecomingReady() async throws {
    let backend = try BackendAddress("https://example.com")
    let credentials = Credentials(backend: backend, token: "expired", userID: 1)
    let repository = try DraftRepository(path: ":memory:")
    let scope = AccountScope(backend: backend, userID: 1)
    try await repository.saveDraft(scope: scope, key: "draft", snapshot: Data("unsaved".utf8),
        generation: 1, expectedLocalVersion: 0)
    let keychain = MemoryCredentials()
    keychain.value = credentials
    let model = SessionModel(api: SessionFixture(credentials: credentials,
        validationError: ConnectError(code: .unauthenticated, message: "expired")),
        credentials: keychain, drafts: repository,
        preferences: try #require(UserDefaults(suiteName: "test.\(UUID())")))
    await model.restore()
    #expect(model.status == .reauthenticationRequired)
    #expect(model.session == nil)
    #expect(keychain.value == credentials)
    model.logout()
    #expect(keychain.value == nil)
    #expect(try await repository.load(scope: scope, key: "draft")?.snapshot == Data("unsaved".utf8))
}

@MainActor @Test func restoredSessionSelectsOnlyItsOwnDrafts() async throws {
    let backend = try BackendAddress("https://example.com")
    let credentials = Credentials(backend: backend, token: "token", userID: 2)
    let repository = try DraftRepository(path: ":memory:")
    try await repository.saveDraft(scope: AccountScope(backend: backend, userID: 1), key: "private",
        snapshot: Data("private".utf8), generation: 1, expectedLocalVersion: 0)
    let keychain = MemoryCredentials()
    keychain.value = credentials
    let model = SessionModel(api: SessionFixture(credentials: credentials), credentials: keychain,
        drafts: repository, preferences: try #require(UserDefaults(suiteName: "test.\(UUID())")))
    await model.restore()
    #expect(model.status == .ready)
    #expect(model.session?.scope.userID == 2)
    #expect(model.retainedDraftCount == 0)
    model.logout()
    #expect(model.session == nil)
}

#if os(iOS)
@MainActor @Test func keychainPersistsUpdatesAndClearsCredentials() throws {
    let service = "secretary.tests.\(UUID())"
    let keychain = KeychainCredentials(service: service)
    defer { try? keychain.clear() }
    let backend = try BackendAddress("https://example.com")
    let first = Credentials(backend: backend, token: "first", userID: 1)
    let replacement = Credentials(backend: backend, token: "second", userID: 2)
    #expect(try keychain.load() == nil)
    try keychain.save(first)
    #expect(try KeychainCredentials(service: service).load() == first)
    try keychain.save(replacement)
    #expect(try keychain.load() == replacement)
    try keychain.clear()
    #expect(try keychain.load() == nil)
}
#endif
