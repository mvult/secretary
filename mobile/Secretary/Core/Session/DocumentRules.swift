import Foundation
import SwiftProtobuf

public enum DocumentEditError: LocalizedError {
    case invalidSnapshot, invalidReceipt, unavailable, unresolved, missingDraft
    public var errorDescription: String? {
        switch self {
        case .invalidSnapshot: "The document has invalid identities or block structure. Your draft is retained."
        case .invalidReceipt: "The acknowledgment did not match the retained request. Retry the same request."
        case .unavailable: "Validate your session before saving. Your draft is retained."
        case .unresolved: "Resolve the pending save or conflict first."
        case .missingDraft: "The local draft could not be loaded."
        }
    }
}

public enum DocumentRules {
    public static func decode(_ data: Data) throws -> Secretary_V1_Document {
        try Secretary_V1_Document(serializedBytes: data)
    }

    /// Canonical preorder, stable client keys, and explicit parent keys for editing.
    public static func normalized(_ source: Secretary_V1_Document) throws -> Secretary_V1_Document {
        var document = source
        guard document.kind != "journal" || (document.directoryID == 0 && JournalDates.date(document.journalDate) != nil) else {
            throw DocumentEditError.invalidSnapshot
        }
        guard document.workspaceID == AppConfiguration.workspaceID, !document.clientKey.isEmpty,
              document.id >= 0, document.revision >= 0 else { throw DocumentEditError.invalidSnapshot }
        let ids = document.blocks.filter { $0.id > 0 }.map(\.id)
        let keys = document.blocks.map(\.clientKey)
        guard Set(ids).count == ids.count, Set(keys).count == keys.count, !keys.contains("") else {
            throw DocumentEditError.invalidSnapshot
        }
        let keyByID = Dictionary(uniqueKeysWithValues: document.blocks.filter { $0.id > 0 }.map { ($0.id, $0.clientKey) })
        for index in document.blocks.indices {
            let block = document.blocks[index]
            if block.parentClientKey.isEmpty, block.parentBlockID > 0 {
                guard let key = keyByID[block.parentBlockID] else { throw DocumentEditError.invalidSnapshot }
                document.blocks[index].parentClientKey = key
            }
            let parent = document.blocks[index].parentClientKey
            guard parent.isEmpty || (parent != block.clientKey && keys.contains(parent)) else { throw DocumentEditError.invalidSnapshot }
        }
        let children = Dictionary(grouping: document.blocks, by: \.parentClientKey)
        func sorted(_ blocks: [Secretary_V1_Block]) -> [Secretary_V1_Block] {
            blocks.sorted { $0.sortOrder == $1.sortOrder ? $0.clientKey < $1.clientKey : $0.sortOrder < $1.sortOrder }
        }
        var ordered: [Secretary_V1_Block] = []
        var stack = Array(sorted(children[""] ?? []).reversed())
        while let block = stack.popLast() {
            ordered.append(block)
            stack.append(contentsOf: sorted(children[block.clientKey] ?? []).reversed())
        }
        guard ordered.count == document.blocks.count else { throw DocumentEditError.invalidSnapshot }
        document.blocks = ordered
        for index in document.blocks.indices { document.blocks[index].sortOrder = Int32(index + 1) }
        return document
    }

    public static func versioned(_ document: Secretary_V1_Document) throws -> Secretary_V1_Document {
        let result = try normalized(document)
        guard result.id > 0, result.revision > 0, result.blocks.allSatisfy({ $0.id > 0 }) else {
            throw DocumentEditError.invalidSnapshot
        }
        return result
    }

    public static func reconcile(_ local: Secretary_V1_Document, saved: Secretary_V1_Document) throws -> Secretary_V1_Document {
        var result = local
        result.id = saved.id; result.clientKey = saved.clientKey; result.revision = saved.revision
        let byKey = Dictionary(uniqueKeysWithValues: saved.blocks.map { ($0.clientKey, $0) })
        for index in result.blocks.indices {
            if let known = byKey[result.blocks[index].clientKey] {
                result.blocks[index].id = known.id
                result.blocks[index].documentID = saved.id
                result.blocks[index].todoID = known.todoID
            }
            result.blocks[index].parentBlockID = byKey[result.blocks[index].parentClientKey]?.id ?? 0
        }
        return try normalized(result)
    }

    public static func prepare(_ record: StoredDraft, scope: AccountScope, deleting: Bool = false) throws -> PendingOperation {
        guard record.pending == nil, record.conflict == nil, record.needsRefresh != true, record.deleted != true, record.archived != true else {
            throw DocumentEditError.unresolved
        }
        var document = try normalized(decode(record.snapshot))
        let baseline = try record.baseline.map { try versioned(decode($0)) }
        guard document.workspaceID == scope.workspaceID,
              document.id == (baseline?.id ?? 0), document.clientKey == (baseline?.clientKey ?? document.clientKey) else {
            throw DocumentEditError.invalidSnapshot
        }
        let mutation = UUID().uuidString.lowercased()
        let revision = baseline?.revision ?? 0
        let bytes: Data
        if deleting {
            guard !record.dirty, let baseline, baseline.kind == "note" else { throw DocumentEditError.unresolved }
            var request = Secretary_V1_DeleteDocumentRequest()
            request.id = baseline.id; request.workspaceID = scope.workspaceID
            request.protocolVersion = 1; request.mutationID = mutation; request.expectedRevision = revision
            bytes = try request.jsonUTF8Data()
        } else {
            let known = Dictionary(uniqueKeysWithValues: (baseline?.blocks ?? []).map { ($0.clientKey, $0.id) })
            for index in document.blocks.indices {
                let block = document.blocks[index]
                guard block.id == 0 || known[block.clientKey] == block.id else { throw DocumentEditError.invalidSnapshot }
                document.blocks[index].id = known[block.clientKey] ?? 0
                document.blocks[index].parentBlockID = known[block.parentClientKey] ?? 0
            }
            var request = Secretary_V1_SaveDocumentRequest()
            request.document = document; request.protocolVersion = 1
            request.mutationID = mutation; request.expectedRevision = revision
            bytes = try request.jsonUTF8Data()
        }
        return PendingOperation(scope: scope, kind: deleting ? .deleteDocument : .saveDocument,
            mutationID: mutation, requestBytes: bytes, submittedSnapshot: record.snapshot,
            submittedGeneration: record.generation, expectedRevision: revision)
    }

    public static func validate(_ receipt: Secretary_V1_SaveDocumentResponse, operation: PendingOperation) throws -> Secretary_V1_Document {
        let submitted = try decode(operation.submittedSnapshot)
        let saved = try versioned(receipt.document)
        guard receipt.mutationID == operation.mutationID, saved.workspaceID == operation.scope.workspaceID else {
            throw DocumentEditError.invalidReceipt
        }
        if receipt.outcome == .existingJournal {
            guard submitted.id == 0, submitted.kind == "journal", saved.kind == "journal",
                  submitted.journalDate == saved.journalDate else { throw DocumentEditError.invalidReceipt }
            return saved
        }
        guard receipt.outcome == .applied, saved.clientKey == submitted.clientKey,
              saved.kind == submitted.kind, saved.journalDate == submitted.journalDate,
              submitted.id == 0 || saved.id == submitted.id,
              let expected = operation.expectedRevision, expected < Int64.max, saved.revision == expected + 1,
              saved.blocks.count == submitted.blocks.count else { throw DocumentEditError.invalidReceipt }
        for block in submitted.blocks {
            guard saved.blocks.contains(where: { $0.clientKey == block.clientKey && (block.id == 0 || block.id == $0.id) }) else {
                throw DocumentEditError.invalidReceipt
            }
        }
        return saved
    }

    public static func validateEnvelope(_ operation: PendingOperation) throws {
        let submitted = try decode(operation.submittedSnapshot)
        guard operation.version == 1, UUID(uuidString: operation.mutationID) != nil,
              submitted.workspaceID == operation.scope.workspaceID else { throw DocumentEditError.invalidSnapshot }
        switch operation.kind {
        case .saveDocument:
            let request = try Secretary_V1_SaveDocumentRequest(jsonUTF8Data: operation.requestBytes)
            guard request.protocolVersion == 1, request.mutationID == operation.mutationID,
                  request.hasExpectedRevision, request.expectedRevision == operation.expectedRevision,
                  request.document.workspaceID == submitted.workspaceID,
                  request.document.id == submitted.id, request.document.clientKey == submitted.clientKey else {
                throw DocumentEditError.invalidSnapshot
            }
        case .deleteDocument:
            let request = try Secretary_V1_DeleteDocumentRequest(jsonUTF8Data: operation.requestBytes)
            guard request.protocolVersion == 1, request.mutationID == operation.mutationID,
                  request.hasExpectedRevision, request.expectedRevision == operation.expectedRevision,
                  request.expectedRevision > 0, request.workspaceID == submitted.workspaceID,
                  request.id == submitted.id, request.id > 0 else { throw DocumentEditError.invalidSnapshot }
        default: throw DocumentEditError.invalidSnapshot
        }
    }
}
