import Foundation

public struct AudioUploadRequest: Codable, Equatable, Sendable {
    public let id: UUID
    public let name: String
    public let duration: Int
    public let sizeBytes: Int64
    public let contentType: String
    enum CodingKeys: String, CodingKey { case id, name, duration; case sizeBytes = "size_bytes", contentType = "content_type" }
    public init(id: UUID, name: String, duration: Int, sizeBytes: Int64, contentType: String = "audio/mp4") {
        self.id = id; self.name = name; self.duration = duration; self.sizeBytes = sizeBytes; self.contentType = contentType
    }
}

public struct AudioUploadAPI: Sendable {
    private let session: URLSession
    public init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 3600
        session = URLSession(configuration: configuration)
    }
    private struct Ticket: Decodable {
        let complete: Bool
        let url: URL?
        let headers: [String: [String]]?
        let recordingID: Int64?
        enum CodingKeys: String, CodingKey { case complete, url, headers; case recordingID = "recording_id" }
    }
    /// The caller persists immutable metadata and the audio file before calling.
    /// Repeating with the same ID recovers a lost response without creating another recording.
    public func upload(_ request: AudioUploadRequest, file: URL, credentials: Credentials) async throws -> Int64 {
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard Int64(size ?? 0) == request.sizeBytes, request.sizeBytes > 0 else { throw URLError(.cannotOpenFile) }
        let ticket = try await post("api/audio/uploads", body: JSONEncoder().encode(request), credentials: credentials)
        if ticket.complete { return try recordingID(ticket) }
        guard let url = ticket.url, url.scheme == "https" else { throw URLError(.badServerResponse) }
        var put = URLRequest(url: url)
        put.httpMethod = "PUT"
        for (name, values) in ticket.headers ?? [:] { put.setValue(values.joined(separator: ", "), forHTTPHeaderField: name) }
        // No backend bearer token is forwarded to object storage.
        let (data, response) = try await session.upload(for: put, fromFile: file)
        try check(data, response)
        let receipt = try await post("api/audio/uploads/\(request.id.uuidString.lowercased())/complete", body: Data("{}".utf8), credentials: credentials)
        return try recordingID(receipt)
    }
    private func recordingID(_ ticket: Ticket) throws -> Int64 {
        guard ticket.complete, let id = ticket.recordingID, id > 0 else { throw URLError(.badServerResponse) }
        return id
    }
    private func post(_ path: String, body: Data, credentials: Credentials) async throws -> Ticket {
        var request = URLRequest(url: credentials.backend.url(path: path))
        request.httpMethod = "POST"; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        try check(data, response)
        return try JSONDecoder().decode(Ticket.self, from: data)
    }
    private func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else { throw BackendAPI.decodeError(data, status: http.statusCode) }
    }
}
