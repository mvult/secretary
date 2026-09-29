import Foundation
import SecretaryCore
import Testing

private func fixtureScope(user: Int64 = 1) throws -> AccountScope {
    AccountScope(backend: try BackendAddress("https://example.com"), userID: user)
}

private func temporaryDatabase() -> String {
    FileManager.default.temporaryDirectory.appendingPathComponent("secretary-\(UUID()).sqlite").path
}

private func operation(_ scope: AccountScope, snapshot: Data, generation: Int64 = 1) -> PendingOperation {
    PendingOperation(scope: scope, kind: .saveDocument, mutationID: UUID().uuidString.lowercased(),
        requestBytes: Data("{\"expectedRevision\":\"0\", \"text\":\"é\"}".utf8),
        submittedSnapshot: snapshot, submittedGeneration: generation, expectedRevision: 0)
}

@Test func crashRecoveryRetainsExactRequestAndNewerEdits() async throws {
    let path = temporaryDatabase()
    defer { try? FileManager.default.removeItem(atPath: path) }
    let scope = try fixtureScope()
    let first = Data("first draft".utf8)
    let newest = Data("typed while saving".utf8)
    let pending = operation(scope, snapshot: first)
    let repository = try DraftRepository(path: path)
    let initial = try await repository.saveDraft(scope: scope, key: "note", snapshot: first,
        generation: 1, expectedLocalVersion: 0)
    let prepared = try await repository.prepare(scope: scope, key: "note", operation: pending,
        expectedLocalVersion: initial.localVersion)
    try await repository.saveDraft(scope: scope, key: "note", snapshot: newest,
        generation: 2, expectedLocalVersion: prepared.localVersion)
    let reopened = try DraftRepository(path: path)
    let recovered = try #require(await reopened.load(scope: scope, key: "note"))
    #expect(recovered.pending == pending)
    #expect(recovered.snapshot == newest)
    let acknowledged = try await reopened.acknowledge(scope: scope, key: "note",
        mutationID: pending.mutationID, baseline: Data("server snapshot".utf8))
    #expect(acknowledged.snapshot == newest)
    #expect(acknowledged.generation == 2)
    #expect(acknowledged.acknowledgedGeneration == 1)
    #expect(acknowledged.pending == nil)
}

@Test func staleWriterAndWrongAcknowledgmentCannotDestroyDraft() async throws {
    let repository = try DraftRepository(path: ":memory:")
    let scope = try fixtureScope()
    let snapshot = Data("keep".utf8)
    let pending = operation(scope, snapshot: snapshot)
    try await repository.saveDraft(scope: scope, key: "note", snapshot: snapshot, generation: 1, expectedLocalVersion: 0)
    await #expect(throws: DraftStorageError.self) {
        try await repository.saveDraft(scope: scope, key: "note", snapshot: Data(), generation: 2, expectedLocalVersion: 0)
    }
    try await repository.prepare(scope: scope, key: "note", operation: pending, expectedLocalVersion: 1)
    await #expect(throws: DraftStorageError.self) {
        try await repository.acknowledge(scope: scope, key: "note", mutationID: "wrong", baseline: Data())
    }
    await #expect(throws: DraftStorageError.self) {
        try await repository.prepare(scope: scope, key: "note", operation: pending, expectedLocalVersion: 2)
    }
    let record = try #require(await repository.load(scope: scope, key: "note"))
    #expect(record.snapshot == snapshot)
    #expect(record.pending == pending)
}

@Test func recoveryRecordsAreIsolatedByAccountBackendAndWorkspace() async throws {
    let repository = try DraftRepository(path: ":memory:")
    let scope = try fixtureScope()
    try await repository.saveDraft(scope: scope, key: "note", snapshot: Data("private".utf8), generation: 1, expectedLocalVersion: 0)
    let others = [
        try fixtureScope(user: 2),
        AccountScope(backend: try BackendAddress("https://example.com/other"), userID: 1),
        AccountScope(backend: scope.backend, userID: 1, workspaceID: 5),
    ]
    for other in others { #expect(try await repository.load(scope: other, key: "note") == nil) }
    let retained = operation(scope, snapshot: Data())
    try await repository.retainCommand(retained)
    try await repository.retainCommand(retained)
    #expect(try await repository.retainedCommands(scope: scope) == [retained])
    #expect(try await repository.retainedCommands(scope: others[0]).isEmpty)
}

@Test func backendScopeNormalizationPreservesDeploymentBoundaries() throws {
    #expect(try BackendAddress(" HTTPS://EXAMPLE.COM:443/api/// ").rawValue == "https://example.com/api")
    #expect(try BackendAddress("http://example.com") != BackendAddress("https://example.com"))
    for invalid in ["example.com", "https://user@example.com", "https://example.com?a=1", "https://example.com/#x"] {
        #expect(throws: ConfigurationError.self) { try BackendAddress(invalid) }
    }
}
