import Foundation
import GRDB

public struct PendingOperation: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case saveDocument, deleteDocument, createTodo, updateTodo, deleteTodo

        var rpcPath: String {
            switch self {
            case .saveDocument: "secretary.v1.DocumentsService/SaveDocument"
            case .deleteDocument: "secretary.v1.DocumentsService/DeleteDocument"
            case .createTodo: "secretary.v1.TodosService/CreateTodo"
            case .updateTodo: "secretary.v1.TodosService/UpdateTodo"
            case .deleteTodo: "secretary.v1.TodosService/DeleteTodo"
            }
        }
    }

    public let version: Int
    public let scope: AccountScope
    public let kind: Kind
    public let mutationID: String
    public let requestBytes: Data
    public let submittedSnapshot: Data
    public let submittedGeneration: Int64
    public let expectedRevision: Int64?
    public var rpcPath: String { kind.rpcPath }

    public init(scope: AccountScope, kind: Kind, mutationID: String, requestBytes: Data,
                submittedSnapshot: Data, submittedGeneration: Int64, expectedRevision: Int64?) {
        version = 1
        self.scope = scope
        self.kind = kind
        self.mutationID = mutationID
        self.requestBytes = requestBytes
        self.submittedSnapshot = submittedSnapshot
        self.submittedGeneration = submittedGeneration
        self.expectedRevision = expectedRevision
    }
}

public struct StoredDraft: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public var localVersion: Int64
    public var snapshot: Data
    public var generation: Int64
    public var acknowledgedGeneration: Int64
    public var baseline: Data?
    public var pending: PendingOperation?
    public var conflict: String?
    public var serverCopy: Data?
    public var serverMissing: Bool?
    public var rejected: Bool?
    public var needsRefresh: Bool?
    public var deleted: Bool?
    public var archived: Bool?
    public var lastError: String?

    public init(snapshot: Data, baseline: Data?) {
        schemaVersion = 1; localVersion = 0; self.snapshot = snapshot
        generation = 0; acknowledgedGeneration = baseline == nil ? -1 : 0
        self.baseline = baseline
    }

    public var dirty: Bool { generation > acknowledgedGeneration }
}

public enum DraftStorageError: LocalizedError {
    case staleWriter, pendingOperation, invalidTransition, unsupportedVersion
    public var errorDescription: String? {
        switch self {
        case .staleWriter: "This draft changed in local storage. Keep your edits and reload its retained state."
        case .pendingOperation: "Resolve the retained operation before preparing another mutation."
        case .invalidTransition: "The recovery record does not match this operation. Local work was retained."
        case .unsupportedVersion: "This recovery record needs a newer app. Its data was retained."
        }
    }
}

/// One serialized repository owns local transitions. SQLite transactions and CAS
/// also protect against another repository/scene writing a stale record.
public actor DraftRepository {
    private let database: DatabaseQueue

    public init(path: String) throws {
        database = try DatabaseQueue(path: path)
        var migrations = DatabaseMigrator()
        migrations.registerMigration("mobile-foundation-v1") { db in
            try db.execute(sql: """
                CREATE TABLE drafts (
                    backend TEXT NOT NULL, user_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
                    draft_key TEXT NOT NULL, payload BLOB NOT NULL,
                    PRIMARY KEY (backend, user_id, workspace_id, draft_key)
                );
                CREATE TABLE commands (
                    backend TEXT NOT NULL, user_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
                    mutation_id TEXT NOT NULL, payload BLOB NOT NULL,
                    PRIMARY KEY (backend, user_id, workspace_id, mutation_id)
                );
                """)
        }
        migrations.registerMigration("mobile-read-cache-v1") { db in
            try db.execute(sql: """
                CREATE TABLE read_cache (
                    backend TEXT NOT NULL, user_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
                    cache_key TEXT NOT NULL, payload BLOB NOT NULL,
                    PRIMARY KEY (backend, user_id, workspace_id, cache_key)
                );
                """)
        }
        migrations.registerMigration("mobile-command-rejections-v1") { db in
            try db.execute(sql: "ALTER TABLE commands ADD COLUMN rejection TEXT")
        }
        try migrations.migrate(database)
    }

    public static func applicationStore() throws -> DraftRepository {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory,
            in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Secretary", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return try DraftRepository(path: directory.appendingPathComponent("drafts.sqlite").path)
    }

    public func load(scope: AccountScope, key: String) throws -> StoredDraft? {
        try database.read { db in try Self.read(db, scope: scope, key: key) }
    }

    public func cached(scope: AccountScope, key: String) throws -> Data? {
        try database.read { db in
            try Data.fetchOne(db, sql: "SELECT payload FROM read_cache WHERE backend = ? AND user_id = ? AND workspace_id = ? AND cache_key = ?",
                arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID, key])
        }
    }

    public func cache(scope: AccountScope, key: String, data: Data?) throws {
        try database.write { db in
            if let data {
                try db.execute(sql: "INSERT OR REPLACE INTO read_cache VALUES (?, ?, ?, ?, ?)",
                    arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID, key, data])
            } else {
                try db.execute(sql: "DELETE FROM read_cache WHERE backend = ? AND user_id = ? AND workspace_id = ? AND cache_key = ?",
                    arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID, key])
            }
        }
    }

    @discardableResult
    public func saveDraft(scope: AccountScope, key: String, snapshot: Data, generation: Int64,
                          expectedLocalVersion: Int64) throws -> StoredDraft {
        try database.write { db in
            let existing = try Self.read(db, scope: scope, key: key)
            guard (existing?.localVersion ?? 0) == expectedLocalVersion else { throw DraftStorageError.staleWriter }
            guard generation >= 0, existing == nil || generation > existing!.generation else {
                throw DraftStorageError.invalidTransition
            }
            var record = existing ?? StoredDraft(snapshot: snapshot, baseline: nil)
            record.snapshot = snapshot
            record.generation = generation
            record.localVersion += 1
            try Self.write(db, scope: scope, key: key, record: record)
            return record
        }
    }

    /// Commits the current draft and immutable envelope together before any send.
    @discardableResult
    public func prepare(scope: AccountScope, key: String, operation: PendingOperation,
                        expectedLocalVersion: Int64) throws -> StoredDraft {
        try database.write { db in
            guard var record = try Self.read(db, scope: scope, key: key),
                  record.localVersion == expectedLocalVersion else { throw DraftStorageError.staleWriter }
            guard record.pending == nil else { throw DraftStorageError.pendingOperation }
            guard operation.version == 1, operation.scope == scope,
                  operation.submittedGeneration == record.generation,
                  operation.submittedSnapshot == record.snapshot,
                  UUID(uuidString: operation.mutationID) != nil, !operation.requestBytes.isEmpty else {
                throw DraftStorageError.invalidTransition
            }
            record.pending = operation
            record.localVersion += 1
            try Self.write(db, scope: scope, key: key, record: record)
            return record
        }
    }

    /// The controller must validate the acknowledgment and reconcile block mappings.
    /// This transaction acknowledges only the submitted generation, retaining newer text.
    @discardableResult
    public func acknowledge(scope: AccountScope, key: String, mutationID: String,
                            baseline: Data) throws -> StoredDraft {
        try database.write { db in
            guard var record = try Self.read(db, scope: scope, key: key),
                  let pending = record.pending, pending.mutationID == mutationID else {
                throw DraftStorageError.invalidTransition
            }
            record.baseline = baseline
            record.acknowledgedGeneration = pending.submittedGeneration
            record.pending = nil
            record.localVersion += 1
            try Self.write(db, scope: scope, key: key, record: record)
            return record
        }
    }

    public func retainCommand(_ operation: PendingOperation) throws {
        guard operation.version == 1, UUID(uuidString: operation.mutationID) != nil,
              !operation.requestBytes.isEmpty else { throw DraftStorageError.invalidTransition }
        let payload = try JSONEncoder().encode(operation)
        try database.write { db in
            let args = Self.arguments(operation.scope, operation.mutationID)
            if let existing = try Data.fetchOne(db, sql: """
                SELECT payload FROM commands WHERE backend=? AND user_id=? AND workspace_id=? AND mutation_id=?
                """, arguments: args) {
                guard try JSONDecoder().decode(PendingOperation.self, from: existing) == operation else {
                    throw DraftStorageError.invalidTransition
                }
                return
            }
            try db.execute(sql: "INSERT INTO commands (backend, user_id, workspace_id, mutation_id, payload) VALUES (?, ?, ?, ?, ?)",
                           arguments: args + [payload])
        }
    }

    public func retainedCommands(scope: AccountScope) throws -> [PendingOperation] {
        try database.read { db in
            let payloads = try Data.fetchAll(db, sql: "SELECT payload FROM commands WHERE backend=? AND user_id=? AND workspace_id=?",
                arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID])
            return try payloads.map {
                let operation = try JSONDecoder().decode(PendingOperation.self, from: $0)
                guard operation.version == 1, operation.scope == scope else { throw DraftStorageError.unsupportedVersion }
                return operation
            }
        }
    }

    public func finishCommand(_ operation: PendingOperation) throws {
        try database.write { db in
            let args = Self.arguments(operation.scope, operation.mutationID)
            guard let payload = try Data.fetchOne(db, sql: "SELECT payload FROM commands WHERE backend=? AND user_id=? AND workspace_id=? AND mutation_id=?", arguments: args),
                  try JSONDecoder().decode(PendingOperation.self, from: payload) == operation else {
                throw DraftStorageError.invalidTransition
            }
            try db.execute(sql: "DELETE FROM commands WHERE backend=? AND user_id=? AND workspace_id=? AND mutation_id=?", arguments: args)
            let scope = operation.scope
            try db.execute(sql: "DELETE FROM read_cache WHERE backend=? AND user_id=? AND workspace_id=? AND (cache_key='index' OR cache_key='todos' OR cache_key LIKE 'body:%')",
                arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID])
        }
    }

    public func rejectCommand(_ operation: PendingOperation, message: String) throws {
        try database.write { db in
            try db.execute(sql: "UPDATE commands SET rejection=? WHERE backend=? AND user_id=? AND workspace_id=? AND mutation_id=?",
                arguments: [message] + Self.arguments(operation.scope, operation.mutationID))
        }
    }

    public func rejectedCommands(scope: AccountScope) throws -> Set<String> {
        try database.read { db in
            Set(try String.fetchAll(db, sql: "SELECT mutation_id FROM commands WHERE backend=? AND user_id=? AND workspace_id=? AND rejection IS NOT NULL",
                arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID]))
        }
    }

    public func retainedDraftCount(scope: AccountScope) throws -> Int {
        try database.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM drafts WHERE backend=? AND user_id=? AND workspace_id=?",
                arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID]) ?? 0
        }
    }

    /// Atomic transitions serialize edits with acknowledgments across actor suspension points.
    @discardableResult
    public func transition(scope: AccountScope, key: String, invalidateCache: Bool = false,
                           update: @Sendable (StoredDraft?) throws -> StoredDraft) throws -> StoredDraft {
        try database.write { db in
            let previous = try Self.read(db, scope: scope, key: key)
            var next = try update(previous)
            next.localVersion = (previous?.localVersion ?? 0) + 1
            try Self.write(db, scope: scope, key: key, record: next)
            if invalidateCache {
                try db.execute(sql: "DELETE FROM read_cache WHERE backend=? AND user_id=? AND workspace_id=?",
                    arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID])
            }
            return next
        }
    }

    public func allDrafts(scope: AccountScope) throws -> [String: StoredDraft] {
        try database.read { db in
            let keys = try String.fetchAll(db, sql: "SELECT draft_key FROM drafts WHERE backend=? AND user_id=? AND workspace_id=?",
                arguments: [scope.backend.rawValue, scope.userID, scope.workspaceID])
            return try Dictionary(uniqueKeysWithValues: keys.compactMap { key in
                try Self.read(db, scope: scope, key: key).map { (key, $0) }
            })
        }
    }

    private static func arguments(_ scope: AccountScope, _ key: String) -> StatementArguments {
        [scope.backend.rawValue, scope.userID, scope.workspaceID, key]
    }

    private static func read(_ db: Database, scope: AccountScope, key: String) throws -> StoredDraft? {
        guard let payload = try Data.fetchOne(db,
            sql: "SELECT payload FROM drafts WHERE backend=? AND user_id=? AND workspace_id=? AND draft_key=?",
            arguments: arguments(scope, key)) else { return nil }
        let record = try JSONDecoder().decode(StoredDraft.self, from: payload)
        guard record.schemaVersion == 1, record.pending == nil || record.pending?.version == 1 else {
            throw DraftStorageError.unsupportedVersion
        }
        guard record.pending == nil || record.pending?.scope == scope else { throw DraftStorageError.invalidTransition }
        return record
    }

    private static func write(_ db: Database, scope: AccountScope, key: String, record: StoredDraft) throws {
        try db.execute(sql: """
            INSERT INTO drafts VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (backend, user_id, workspace_id, draft_key) DO UPDATE SET payload=excluded.payload
            """, arguments: arguments(scope, key) + [try JSONEncoder().encode(record)])
    }
}
