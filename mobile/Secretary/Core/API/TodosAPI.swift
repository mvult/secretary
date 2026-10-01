import Connect
import Foundation

public protocol TodosAPI: Sendable {
    func todos(_ credentials: Credentials) async throws -> [Secretary_V1_Todo]
    func canDeleteTodos(_ credentials: Credentials) async throws -> Bool
    func sendRetained(_ operation: PendingOperation, credentials: Credentials) async throws -> Data
}

extension BackendAPI: TodosAPI {
    public func todos(_ credentials: Credentials) async throws -> [Secretary_V1_Todo] {
        let client = ProtocolClient(httpClient: httpClient, config: .init(host: credentials.backend.rawValue, timeout: 30))
        var request = Secretary_V1_ListTodosRequest(); request.userID = credentials.userID
        return try await Secretary_V1_TodosServiceClient(client: client).listTodos(request: request,
            headers: ["Authorization": ["Bearer \(credentials.token)"]]).result.get().todos
    }
    public func canDeleteTodos(_ credentials: Credentials) async throws -> Bool {
        let client = ProtocolClient(httpClient: httpClient, config: .init(host: credentials.backend.rawValue, timeout: 30))
        let users = try await Secretary_V1_UsersServiceClient(client: client).listUsers(request: .init(),
            headers: ["Authorization": ["Bearer \(credentials.token)"]]).result.get().users
        return users.first(where: { $0.id == credentials.userID })?.role == "admin"
    }
}
