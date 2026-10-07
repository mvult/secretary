import Connect
import Foundation
import SecretaryCore
import SwiftProtobuf
import Testing

private final class HTTPFixtures: @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, Data)
    private let lock = NSLock()
    private var handlers: [String: Handler] = [:]
    func set(_ host: String, handler: @escaping Handler) { lock.withLock { handlers[host] = handler } }
    func remove(_ host: String) { lock.withLock { _ = handlers.removeValue(forKey: host) } }
    func handler(_ host: String) -> Handler? { lock.withLock { handlers[host] } }
}

private final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    static let fixtures = HTTPFixtures()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let url = try #require(request.url)
            let handler = try #require(Self.fixtures.handler(url.host!))
            let (status, data) = try handler(request)
            let response = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private func fixtureAPI() -> BackendAPI {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [FixtureProtocol.self]
    return BackendAPI(configuration: config)
}

private func readBody(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        guard count > 0 else { break }
        body.append(contentsOf: buffer.prefix(count))
    }
    return body
}

private final class AudioFixtureState: @unchecked Sendable {
    let lock = NSLock()
    var completed = false
    var puts = 0
    var bodies: [Data] = []
}

@Test func audioUploadLostFinalResponseRetriesReceiptWithoutUploadingAgain() async throws {
    let host = "\(UUID().uuidString.lowercased()).example.com"
    let objectHost = "\(UUID().uuidString.lowercased()).example.com"
    let state = AudioFixtureState()
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID()).m4a")
    try Data("audio".utf8).write(to: file)
    let upload = AudioUploadRequest(id: UUID(), name: "Meeting", duration: 12, sizeBytes: 5)
    FixtureProtocol.fixtures.set(host) { request in
        try state.lock.withLock {
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
            if request.url!.path == "/api/audio/uploads" {
                let body = readBody(request)
                state.bodies.append(body)
                #expect(try JSONDecoder().decode(AudioUploadRequest.self, from: body) == upload)
                if state.completed { return (200, Data("{\"complete\":true,\"recording_id\":42}".utf8)) }
                return (200, Data("{\"complete\":false,\"url\":\"https://\(objectHost)/audio\",\"headers\":{\"Content-Type\":[\"audio/mp4\"]}}".utf8))
            }
            #expect(request.url!.path == "/api/audio/uploads/\(upload.id.uuidString.lowercased())/complete")
            state.completed = true
            throw URLError(.networkConnectionLost)
        }
    }
    FixtureProtocol.fixtures.set(objectHost) { request in
        state.lock.withLock { state.puts += 1 }
        #expect(request.httpMethod == "PUT")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "audio/mp4")
        return (200, Data())
    }
    defer {
        FixtureProtocol.fixtures.remove(host); FixtureProtocol.fixtures.remove(objectHost)
        try? FileManager.default.removeItem(at: file)
    }
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureProtocol.self]
    let credentials = Credentials(backend: try BackendAddress("https://\(host)"), token: "secret", userID: 7)
    do {
        _ = try await AudioUploadAPI(configuration: config).upload(upload, file: file, credentials: credentials)
        Issue.record("Expected lost response")
    } catch { #expect((error as? URLError)?.code == .networkConnectionLost) }
    let id = try await AudioUploadAPI(configuration: config).upload(upload, file: file, credentials: credentials)
    #expect(id == 42)
    state.lock.withLock { #expect(state.puts == 1 && state.bodies.count == 2) }
    #expect(FileManager.default.fileExists(atPath: file.path))
}

@Test func generatedProtocolPreservesPresenceInt64AndTypedErrors() throws {
    var create = Secretary_V1_SaveDocumentRequest()
    create.protocolVersion = 1
    create.expectedRevision = 0
    create.mutationID = UUID().uuidString.lowercased()
    create.document.clientKey = "document-key"
    let encoded = try create.jsonUTF8Data()
    let decoded = try Secretary_V1_SaveDocumentRequest(jsonUTF8Data: encoded)
    #expect(decoded.hasExpectedRevision)
    #expect(decoded.expectedRevision == 0)
    #expect(decoded.document.clientKey == "document-key")
    #expect(!Secretary_V1_SaveDocumentRequest().hasExpectedRevision)
    create.expectedRevision = 9_007_199_254_740_993
    #expect(try Secretary_V1_SaveDocumentRequest(jsonUTF8Data: create.jsonUTF8Data()).expectedRevision == 9_007_199_254_740_993)
    var detail = Secretary_V1_PersistenceError()
    detail.reason = .revisionConflict
    detail.currentRevision = Int64.max
    let body = try JSONSerialization.data(withJSONObject: [
        "code": "aborted", "message": "conflict",
        "details": [["type": "secretary.v1.PersistenceError", "value": try detail.serializedData().base64EncodedString()]],
    ])
    let error = BackendAPI.decodeError(body, status: 409)
    let details: [Secretary_V1_PersistenceError] = error.unpackedDetails()
    #expect(error.code == .aborted)
    #expect(details.first?.reason == .revisionConflict)
    #expect(details.first?.currentRevision == Int64.max)
    #expect(BackendAPI.decodeError(Data("{\"error\":\"expired\"}".utf8), status: 401).code == .unauthenticated)
}

@Test func loginAndGeneratedReadsValidateAuthenticatedWorkspace() async throws {
    let host = "\(UUID().uuidString.lowercased()).example.com"
    let token = "header.\(Data("{\"sub\":\"7\"}".utf8).base64EncodedString()).signature"
    FixtureProtocol.fixtures.set(host) { request in
        switch request.url!.path {
        case "/deployment/api/login":
            let body = try #require(JSONSerialization.jsonObject(with: readBody(request)) as? [String: String])
            #expect(body["email"] == "user@example.com")
            #expect(body["password"] == "password")
            return (200, Data("{\"token\":\"\(token)\",\"user\":{\"id\":7}}".utf8))
        case "/deployment/secretary.v1.WorkspacesService/ListWorkspaces":
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
            return (200, Data("{\"workspaces\":[{\"id\":\"4\",\"name\":\"Personal\"}]}".utf8))
        case "/deployment/secretary.v1.DocumentsService/ListDocumentIndex":
            let query = try Secretary_V1_ListDocumentIndexRequest(jsonUTF8Data: readBody(request))
            #expect(query.workspaceID == 4)
            #expect(query.pageSize == 1)
            return (200, Data("{\"persistenceProtocolVersion\":1}".utf8))
        default: throw URLError(.badURL)
        }
    }
    defer { FixtureProtocol.fixtures.remove(host) }
    let api = fixtureAPI()
    let credentials = try await api.login(backend: BackendAddress("https://\(host)/deployment"),
        email: "user@example.com", password: "password")
    let validated = try await api.validate(credentials)
    #expect(validated.scope.userID == 7)
    #expect(validated.scope.workspaceID == 4)
    #expect(validated.protocolVersion == 1)
}

@Test(arguments: [0, 2]) func incompatibleServerCannotBecomeReady(version: Int) async throws {
    let host = "\(UUID().uuidString.lowercased()).example.com"
    let token = "header.\(Data("{\"sub\":\"7\"}".utf8).base64EncodedString()).signature"
    FixtureProtocol.fixtures.set(host) { request in
        if request.url!.path.hasSuffix("ListWorkspaces") {
            return (200, Data("{\"workspaces\":[{\"id\":\"4\"}]}".utf8))
        }
        return (200, Data("{\"persistenceProtocolVersion\":\(version)}".utf8))
    }
    defer { FixtureProtocol.fixtures.remove(host) }
    let credentials = Credentials(backend: try BackendAddress("https://\(host)"), token: token, userID: 7)
    await #expect(throws: SessionError.self) { try await fixtureAPI().validate(credentials) }
}

@Test func retainedTransportSendsIdenticalBytesAndDecodesAuthenticationFailure() async throws {
    let host = "\(UUID().uuidString.lowercased()).example.com"
    let backend = try BackendAddress("https://\(host)")
    let bytes = Data("{ \"expectedRevision\": \"0\", \"title\": \"é\" }".utf8)
    FixtureProtocol.fixtures.set(host) { request in
        #expect(readBody(request) == bytes)
        #expect(request.value(forHTTPHeaderField: "Connect-Protocol-Version") == "1")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token")
        return (401, Data("{\"error\":\"expired\"}".utf8))
    }
    defer { FixtureProtocol.fixtures.remove(host) }
    let pending = PendingOperation(scope: AccountScope(backend: backend, userID: 7), kind: .saveDocument,
        mutationID: UUID().uuidString, requestBytes: bytes, submittedSnapshot: Data(), submittedGeneration: 1, expectedRevision: 0)
    do {
        _ = try await fixtureAPI().sendRetained(pending, credentials: Credentials(backend: backend, token: "token", userID: 7))
        Issue.record("Expected authentication failure")
    } catch let error as ConnectError { #expect(error.code == .unauthenticated) }
}

@Test func directoryUpdatesUsePresenceAwarePatches() async throws {
    let host = "\(UUID().uuidString.lowercased()).example.com"
    FixtureProtocol.fixtures.set(host) { request in
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token")
        let update = try Secretary_V1_UpdateDirectoryRequest(jsonUTF8Data: readBody(request))
        #expect(update.id == 5)
        #expect(update.name.isEmpty && update.parentID == 0)
        #expect(update.hasPatch)
        if update.patch.hasName {
            #expect(update.patch.name == "Renamed")
            #expect(!update.patch.hasParentID)
        } else {
            #expect(update.patch.hasParentID)
            #expect(update.patch.parentID == 0)
        }
        return (200, Data("{}".utf8))
    }
    defer { FixtureProtocol.fixtures.remove(host) }
    let credentials = Credentials(backend: try BackendAddress("https://\(host)"), token: "token", userID: 1)
    let api = fixtureAPI()
    try await api.updateDirectory(credentials, id: 5, name: "Renamed", parent: nil)
    try await api.updateDirectory(credentials, id: 5, name: nil, parent: 0)
}
