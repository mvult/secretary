import AVFoundation
import Observation
import SecretaryCore
import SwiftUI

private struct CapturedAudio: Codable, Identifiable {
    let id: UUID
    let backend: String
    let userID: Int64
    let createdAt: Date
    let name: String
    var duration = 0
    var sizeBytes: Int64 = 0
    var finished = false
    var recordingID: Int64?
    var request: AudioUploadRequest { .init(id: id, name: name, duration: duration, sizeBytes: sizeBytes) }
}

@MainActor @Observable
final class MobileRecorder: NSObject, AVAudioRecorderDelegate {
    fileprivate var captures: [CapturedAudio] = []
    private(set) var activeID: UUID?
    private(set) var uploadingID: UUID?
    private(set) var paused = false
    private(set) var starting = false
    var message: String?
    private var recorder: AVAudioRecorder?
    private var directory: URL?
    private var backend: String?
    private var userID: Int64?
    private var interruption: NSObjectProtocol?
    private var routeChange: NSObjectProtocol?
    var elapsed: TimeInterval { recorder?.currentTime ?? 0 }

    override init() {
        super.init()
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            let began = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            if began { Task { @MainActor in self?.stop(); self?.message = "Recording stopped by an audio interruption. Audio is kept locally." } }
        }
        routeChange = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            let disconnected = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
            if disconnected { Task { @MainActor in self?.stop() } }
        }
    }

    func load(credentials: Credentials) {
        guard backend != credentials.backend.rawValue || userID != credentials.userID else { return }
        stop()
        backend = credentials.backend.rawValue; userID = credentials.userID; captures = []; message = nil
        do {
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("CapturedAudio", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            directory = root
            for file in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) where file.pathExtension == "json" {
                var capture = try JSONDecoder().decode(CapturedAudio.self, from: Data(contentsOf: file))
                guard capture.backend == backend, capture.userID == userID else { continue }
                if !capture.finished {
                    do {
                        let player = try AVAudioPlayer(contentsOf: audioURL(capture.id))
                        capture.duration = Int(player.duration)
                        capture.sizeBytes = Int64(try audioURL(capture.id).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
                        capture.finished = capture.sizeBytes > 0
                        try persist(capture)
                    } catch { message = "An interrupted recording could not be finalized. Its local file is retained for export." }
                }
                captures.append(capture)
            }
            captures.sort { $0.createdAt > $1.createdAt }
        } catch { message = error.localizedDescription }
    }

    func start(name: String, session model: SessionModel) async {
        guard activeID == nil, !starting, uploadingID == nil else { return }
        guard let credentials = model.validatedCredentials else { return }
        starting = true; defer { starting = false }
        guard await AVAudioApplication.requestRecordPermission() else { message = "Enable microphone access for Secretary in Settings."; return }
        guard model.validatedCredentials == credentials else { return }
        load(credentials: credentials)
        do {
            guard directory != nil else { throw CocoaError(.fileNoSuchFile) }
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
            try session.setActive(true)
            let capture = CapturedAudio(id: UUID(), backend: credentials.backend.rawValue, userID: credentials.userID, createdAt: Date(),
                name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Recording \(Date().formatted(date: .abbreviated, time: .shortened))" : name)
            try persist(capture)
            captures.insert(capture, at: 0)
            let audio = try AVAudioRecorder(url: audioURL(capture.id), settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
            ])
            audio.delegate = self
            guard audio.record() else { throw CocoaError(.fileWriteUnknown) }
            recorder = audio; activeID = capture.id; paused = false; message = nil
        } catch { message = error.localizedDescription; try? AVAudioSession.sharedInstance().setActive(false) }
    }
    func togglePause() {
        guard let recorder else { return }
        if paused { paused = !recorder.record() } else { recorder.pause(); paused = true }
    }
    func stop() {
        guard let id = activeID, let recorder else { return }
        let duration = Int(recorder.currentTime)
        activeID = nil; paused = false; self.recorder = nil
        recorder.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let index = captures.firstIndex(where: { $0.id == id }) else { return }
        do {
            var capture = captures[index]
            capture.duration = duration
            capture.sizeBytes = Int64(try audioURL(id).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
            capture.finished = capture.sizeBytes > 0
            try persist(capture)
            captures[index] = capture
        } catch { message = error.localizedDescription }
    }
    fileprivate func upload(_ capture: CapturedAudio, credentials: Credentials) async {
        guard uploadingID == nil, activeID == nil, capture.finished, capture.recordingID == nil,
              capture.backend == credentials.backend.rawValue, capture.userID == credentials.userID else { return }
        uploadingID = capture.id; message = nil
        defer { uploadingID = nil }
        do {
            let id = try await AudioUploadAPI().upload(capture.request, file: audioURL(capture.id), credentials: credentials)
            var saved = capture; saved.recordingID = id
            try persist(saved)
            if let index = captures.firstIndex(where: { $0.id == capture.id }) { captures[index] = saved }
        } catch { if backend == capture.backend, userID == capture.userID { message = "Upload retained for retry: \(error.localizedDescription)" } }
    }
    fileprivate func removeLocal(_ capture: CapturedAudio) {
        guard activeID != capture.id, uploadingID != capture.id, capture.recordingID != nil else { return }
        do {
            try FileManager.default.removeItem(at: audioURL(capture.id))
            try FileManager.default.removeItem(at: manifestURL(capture.id))
            captures.removeAll { $0.id == capture.id }
        } catch { message = error.localizedDescription }
    }
    func audioURL(_ id: UUID) -> URL { directory!.appendingPathComponent("\(id.uuidString).m4a") }
    private func manifestURL(_ id: UUID) -> URL { directory!.appendingPathComponent("\(id.uuidString).json") }
    private func persist(_ capture: CapturedAudio) throws {
        guard directory != nil else { throw CocoaError(.fileNoSuchFile) }
        try JSONEncoder().encode(capture).write(to: manifestURL(capture.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let detail = error?.localizedDescription ?? "Audio encoding failed"
        Task { @MainActor in self.stop(); self.message = detail }
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let url = recorder.url
        Task { @MainActor in
            if self.recorder?.url == url { self.stop(); if !flag { self.message = "Recording interrupted. The local file is retained." } }
        }
    }
}

struct RecordingsView: View {
    @Bindable var session: SessionModel
    @Bindable var recorder: MobileRecorder
    @State private var name = ""
    var body: some View {
        NavigationStack {
            List {
                Section {
                    if recorder.activeID != nil {
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            Text(Duration.seconds(recorder.elapsed).formatted(.time(pattern: .hourMinuteSecond)))
                                .font(.largeTitle.monospacedDigit()).foregroundStyle(recorder.paused ? .secondary : .primary)
                        }
                        HStack {
                            Button(recorder.paused ? "Resume" : "Pause") { recorder.togglePause() }
                            Spacer()
                            Button("Stop & upload", role: .destructive) {
                                let id = recorder.activeID
                                recorder.stop()
                                if let capture = recorder.captures.first(where: { $0.id == id }), let credentials = session.validatedCredentials {
                                    Task { await recorder.upload(capture, credentials: credentials) }
                                }
                            }
                        }.buttonStyle(.borderless)
                    } else {
                        TextField("Recording name", text: $name)
                        Button("Record", systemImage: "mic.fill") {
                            Task { await recorder.start(name: name, session: session) }
                        }.disabled(session.validatedCredentials == nil || recorder.starting || recorder.uploadingID != nil)
                    }
                }
                if let message = recorder.message { Text(message).font(.caption).foregroundStyle(.red) }
                Section("On this iPhone") {
                    ForEach(recorder.captures) { capture in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(capture.name)
                            if let id = capture.recordingID {
                                Text("Uploaded · recording #\(id)").font(.caption).foregroundStyle(.secondary)
                            } else if recorder.uploadingID == capture.id {
                                HStack { ProgressView(); Text("Uploading…").font(.caption) }
                            } else if capture.finished {
                                Text("\(capture.duration / 60)m \(capture.duration % 60)s · saved locally").font(.caption).foregroundStyle(.secondary)
                                Button("Upload / retry") {
                                    if let credentials = session.validatedCredentials { Task { await recorder.upload(capture, credentials: credentials) } }
                                }.disabled(session.validatedCredentials == nil || recorder.uploadingID != nil || recorder.activeID != nil)
                            } else if recorder.activeID != capture.id {
                                Text("Interrupted recording · export local audio").font(.caption).foregroundStyle(.secondary)
                            }
                            if recorder.activeID != capture.id {
                                ShareLink("Export audio", item: recorder.audioURL(capture.id))
                            }
                        }
                        .contextMenu {
                            if capture.recordingID != nil { Button("Remove local copy", role: .destructive) { recorder.removeLocal(capture) } }
                        }
                    }
                }
            }
            .navigationTitle("Recordings")
            .task(id: session.status) {
                if let credentials = session.validatedCredentials { recorder.load(credentials: credentials) }
            }
        }
    }
}
