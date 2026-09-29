import Foundation
import Security

@MainActor
public protocol CredentialStore {
    func load() throws -> Credentials?
    func save(_ credentials: Credentials) throws
    func clear() throws
}

@MainActor
public final class KeychainCredentials: CredentialStore {
    private let service: String
    public init(service: String = "secretary.ios.session") { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: "active-session"]
    }

    public func load() throws -> Credentials? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = result as? Data else { throw KeychainError(status: errSecDecode) }
        return try JSONDecoder().decode(Credentials.self, from: data)
    }

    public func save(_ credentials: Credentials) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(credentials),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            try check(SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil))
        } else { try check(status) }
    }

    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }

    private func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }
}

private struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "Keychain: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))" }
}
