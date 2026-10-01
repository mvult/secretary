import Connect
import Foundation

public protocol NotesAPI: Sendable {
    func index(_ credentials: Credentials, before: Int64) async throws -> Secretary_V1_ListDocumentIndexResponse
    func document(_ credentials: Credentials, id: Int64) async throws -> Secretary_V1_Document
    func createDirectory(_ credentials: Credentials, name: String, parent: Int64) async throws
    func updateDirectory(_ credentials: Credentials, id: Int64, name: String?, parent: Int64?) async throws
    func deleteDirectory(_ credentials: Credentials, id: Int64) async throws
}

extension BackendAPI: NotesAPI {
    private func documents(_ credentials: Credentials) -> Secretary_V1_DocumentsServiceClient {
        Secretary_V1_DocumentsServiceClient(client: ProtocolClient(httpClient: httpClient,
            config: .init(host: credentials.backend.rawValue, timeout: 30)))
    }
    private func headers(_ credentials: Credentials) -> Headers { ["Authorization": ["Bearer \(credentials.token)"]] }
    public func index(_ credentials: Credentials, before: Int64) async throws -> Secretary_V1_ListDocumentIndexResponse {
        var request = Secretary_V1_ListDocumentIndexRequest()
        request.workspaceID = AppConfiguration.workspaceID
        request.beforeID = before
        request.pageSize = 100
        return try await documents(credentials).listDocumentIndex(request: request, headers: headers(credentials)).result.get()
    }
    public func document(_ credentials: Credentials, id: Int64) async throws -> Secretary_V1_Document {
        var request = Secretary_V1_GetDocumentRequest(); request.id = id
        return try await documents(credentials).getDocument(request: request, headers: headers(credentials)).result.get().document
    }
    public func createDirectory(_ credentials: Credentials, name: String, parent: Int64) async throws {
        var request = Secretary_V1_CreateDirectoryRequest()
        request.workspaceID = AppConfiguration.workspaceID; request.name = name; request.parentID = parent
        _ = try await documents(credentials).createDirectory(request: request, headers: headers(credentials)).result.get()
    }
    public func updateDirectory(_ credentials: Credentials, id: Int64, name: String?, parent: Int64?) async throws {
        var request = Secretary_V1_UpdateDirectoryRequest(); request.id = id
        if let name { request.patch.name = name }
        if let parent { request.patch.parentID = parent }
        _ = try await documents(credentials).updateDirectory(request: request, headers: headers(credentials)).result.get()
    }
    public func deleteDirectory(_ credentials: Credentials, id: Int64) async throws {
        var request = Secretary_V1_DeleteDirectoryRequest(); request.id = id
        _ = try await documents(credentials).deleteDirectory(request: request, headers: headers(credentials)).result.get()
    }
}
