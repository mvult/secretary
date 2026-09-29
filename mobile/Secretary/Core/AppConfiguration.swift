import Foundation

public enum AppConfiguration {
    public static let workspaceID: Int64 = 4
    public static let defaultBackendURL = "http://localhost:8091"
}

public struct BackendAddress: Codable, Hashable, Sendable {
    public let rawValue: String

    public init(_ value: String) throws {
        guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil
        else { throw ConfigurationError.invalidBackendURL }
        parts.scheme = scheme
        parts.host = host
        if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) {
            parts.port = nil
        }
        while parts.path.hasSuffix("/") { parts.path.removeLast() }
        guard let normalized = parts.url?.absoluteString else { throw ConfigurationError.invalidBackendURL }
        rawValue = normalized
    }

    public func url(path: String) -> URL {
        // Paths are application-owned RPC/login paths, never user input.
        URL(string: rawValue + "/" + path)!
    }
}

public struct AccountScope: Codable, Hashable, Sendable {
    public let backend: BackendAddress
    public let userID: Int64
    public let workspaceID: Int64

    public init(backend: BackendAddress, userID: Int64, workspaceID: Int64 = AppConfiguration.workspaceID) {
        self.backend = backend
        self.userID = userID
        self.workspaceID = workspaceID
    }
}

public enum ConfigurationError: LocalizedError {
    case invalidBackendURL
    public var errorDescription: String? { "Enter an HTTP or HTTPS backend URL without credentials, query, or fragment." }
}
