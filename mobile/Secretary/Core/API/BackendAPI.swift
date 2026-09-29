import Connect
import Foundation
import SwiftProtobuf

public struct Credentials: Codable, Equatable, Sendable {
    public let backend: BackendAddress
    public let token: String
    public let userID: Int64

    public init(backend: BackendAddress, token: String, userID: Int64) {
        self.backend = backend
        self.token = token
        self.userID = userID
    }
}

public struct ValidatedSession: Sendable {
    public let scope: AccountScope
    public let workspaceName: String
    public let protocolVersion: UInt32

    public init(scope: AccountScope, workspaceName: String, protocolVersion: UInt32) {
        self.scope = scope
        self.workspaceName = workspaceName
        self.protocolVersion = protocolVersion
    }
}

public protocol SessionAPI: Sendable {
    func login(backend: BackendAddress, email: String, password: String) async throws -> Credentials
    func validate(_ credentials: Credentials) async throws -> ValidatedSession
}

public struct BackendAPI: SessionAPI, Sendable {
    private let session: URLSession
    private let httpClient: URLSessionHTTPClient

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
        httpClient = URLSessionHTTPClient(configuration: configuration)
    }

    public func login(backend: BackendAddress, email: String, password: String) async throws -> Credentials {
        struct LoginBody: Encodable { let email: String; let password: String }
        struct LoginResponse: Decodable {
            struct User: Decodable { let id: Int64 }
            let token: String
            let user: User
        }
        let body = try JSONEncoder().encode(LoginBody(email: email, password: password))
        let data = try await post(backend: backend, path: "api/login", body: body, token: nil)
        let response = try JSONDecoder().decode(LoginResponse.self, from: data)
        guard response.user.id > 0, !response.token.isEmpty else { throw SessionError.invalidIdentity }
        return Credentials(backend: backend, token: response.token, userID: response.user.id)
    }

    public func validate(_ credentials: Credentials) async throws -> ValidatedSession {
        let client = ProtocolClient(httpClient: httpClient, config: .init(
            host: credentials.backend.rawValue, timeout: 30
        ))
        let headers: Headers = ["Authorization": ["Bearer \(credentials.token)"]]
        let workspaces = try await Secretary_V1_WorkspacesServiceClient(client: client)
            .listWorkspaces(request: .init(), headers: headers).result.get()
        // There is no self endpoint yet. The subject is trusted only after the backend
        // has authenticated this exact token through the workspace RPC.
        guard try Self.authenticatedSubject(credentials.token) == credentials.userID else {
            throw SessionError.invalidIdentity
        }
        guard let workspace = workspaces.workspaces.first(where: { $0.id == AppConfiguration.workspaceID }) else {
            throw SessionError.workspaceDenied
        }
        var request = Secretary_V1_ListDocumentIndexRequest()
        request.workspaceID = workspace.id
        request.pageSize = 1
        let index = try await Secretary_V1_DocumentsServiceClient(client: client)
            .listDocumentIndex(request: request, headers: headers).result.get()
        guard index.persistenceProtocolVersion == 1 else { throw SessionError.protocolUnsupported }
        return ValidatedSession(
            scope: AccountScope(backend: credentials.backend, userID: credentials.userID),
            workspaceName: workspace.name, protocolVersion: index.persistenceProtocolVersion
        )
    }

    /// Caller must load these bytes from committed recovery storage and validate the
    /// session/scope/capability before use. This transport never retries or re-encodes.
    public func sendRetained(_ operation: PendingOperation, credentials: Credentials) async throws -> Data {
        guard operation.scope.backend == credentials.backend,
              operation.scope.userID == credentials.userID,
              operation.scope.workspaceID == AppConfiguration.workspaceID else { throw SessionError.invalidIdentity }
        return try await post(backend: credentials.backend, path: operation.rpcPath,
                              body: operation.requestBytes, token: credentials.token)
    }

    private func post(backend: BackendAddress, path: String, body: Data, token: String?) async throws -> Data {
        var request = URLRequest(url: backend.url(path: path))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("1", forHTTPHeaderField: "Connect-Protocol-Version")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else { throw Self.decodeError(data, status: http.statusCode) }
        return data
    }

    public static func decodeError(_ data: Data, status: Int) -> ConnectError {
        let decoded = try? JSONDecoder().decode(ConnectError.self, from: data)
        struct RESTError: Decodable { let error: String }
        let fallback = (try? JSONDecoder().decode(RESTError.self, from: data))?.error
        let code: Code = status == 401 ? .unauthenticated : status == 403 ? .permissionDenied : decoded?.code ?? .unknown
        return ConnectError(code: code, message: decoded?.message ?? fallback ?? "HTTP \(status)",
                            details: decoded?.details ?? [])
    }

    private static func authenticatedSubject(_ token: String) throws -> Int64 {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { throw SessionError.invalidIdentity }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        struct Claims: Decodable { let sub: String }
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONDecoder().decode(Claims.self, from: data),
              let id = Int64(claims.sub), id > 0 else { throw SessionError.invalidIdentity }
        return id
    }
}

public enum SessionError: LocalizedError {
    case invalidIdentity, workspaceDenied, protocolUnsupported
    public var errorDescription: String? {
        switch self {
        case .invalidIdentity: "The authenticated account does not match the retained session. Sign in again."
        case .workspaceDenied: "This account cannot access workspace \(AppConfiguration.workspaceID)."
        case .protocolUnsupported: "This server does not advertise persistence protocol v1. Update the server before editing."
        }
    }
}
