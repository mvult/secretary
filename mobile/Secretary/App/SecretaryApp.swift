import SecretaryCore
import SwiftUI

@main
struct SecretaryApp: App {
    @State private var model: SessionModel?
    @State private var startupError: String?
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if let model {
                    SessionView(model: model)
                } else if let startupError {
                    ContentUnavailableView("Local storage unavailable", systemImage: "externaldrive.badge.exclamationmark",
                        description: Text(startupError))
                } else {
                    ProgressView("Opening Secretary")
                }
            }
            .task {
                guard model == nil, startupError == nil else { return }
                do {
                    let repository = try DraftRepository.applicationStore()
                    let session = SessionModel(api: BackendAPI(), credentials: KeychainCredentials(), drafts: repository)
                    model = session
                    await session.restore()
                } catch { startupError = error.localizedDescription }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, let model {
                    Task { await model.validateActiveSession() }
                }
            }
        }
    }
}

private struct SessionView: View {
    @Bindable var model: SessionModel
    @State private var recorder = MobileRecorder()

    var body: some View {
        if model.status == .restoring {
            ProgressView("Restoring session")
        } else if model.session != nil {
            TabView {
                Tab("Notes", systemImage: "doc.text") { NotesView(model: model.notes) }
                Tab("Journals", systemImage: "calendar") { JournalsView(model: model.notes) }
                Tab("TODOs", systemImage: "checklist") { TodosView(model: model.todos, notes: model.notes) }
                Tab("Record", systemImage: "mic") { RecordingsView(session: model, recorder: recorder) }
                Tab("Settings", systemImage: "gearshape") { SettingsView(model: model) }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if model.status != .ready {
                    Text(model.message ?? "Validating session…")
                        .font(.caption).frame(maxWidth: .infinity).padding(8).background(.thinMaterial)
                }
            }
            .onChange(of: model.session?.scope) { _, _ in recorder.stop() }
            .onDisappear { recorder.stop() }
        } else {
            LoginView(model: model)
        }
    }
}

private struct FeaturePlaceholder: View {
    let title: String
    let icon: String
    var body: some View {
        NavigationStack {
            ContentUnavailableView(title, systemImage: icon,
                description: Text("This screen is planned for the next implementation phases."))
                .navigationTitle(title)
        }
    }
}

private struct LoginView: View {
    @Bindable var model: SessionModel
    @State private var backendURL = ""
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focus: Field?
    private enum Field { case backend, email, password }

    var body: some View {
        NavigationStack {
            Form {
                Section("Backend") {
                    TextField("Backend URL", text: $backendURL)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .backend).accessibilityIdentifier("backendURL")
                }
                Section("Account") {
                    TextField("Email", text: $email)
                        .textContentType(.username).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .email).accessibilityIdentifier("email")
                    SecureField("Password", text: $password)
                        .textContentType(.password).focused($focus, equals: .password)
                        .onSubmit { signIn() }.accessibilityIdentifier("password")
                }
                Section {
                    Button(action: signIn) {
                        HStack {
                            Text("Sign in")
                            Spacer()
                            if model.status == .validating { ProgressView() }
                        }
                    }
                    .disabled(model.status == .validating || email.isEmpty || password.isEmpty || backendURL.isEmpty)
                    .accessibilityIdentifier("signIn")
                } footer: {
                    Text("Workspace \(AppConfiguration.workspaceID)")
                }
                if let message = model.message {
                    Section { Text(message).foregroundStyle(.red).textSelection(.enabled) }
                }
            }
            .navigationTitle("Secretary")
            .onAppear { backendURL = model.backendURL }
        }
    }

    private func signIn() {
        guard model.status != .validating, !email.isEmpty, !password.isEmpty else { return }
        focus = nil
        let submittedPassword = password
        password = ""
        Task { await model.login(backendURL: backendURL, email: email, password: submittedPassword) }
    }
}

private struct SettingsView: View {
    @Bindable var model: SessionModel
    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    LabeledContent("Backend", value: model.backendURL).textSelection(.enabled)
                    LabeledContent("Status", value: model.status.rawValue)
                    if let session = model.session {
                        LabeledContent("Account", value: String(session.scope.userID))
                        LabeledContent("Workspace", value: "\(session.workspaceName) (\(session.scope.workspaceID))")
                        LabeledContent("Persistence protocol", value: String(session.protocolVersion))
                    }
                    Button("Validate connection") { Task { await model.validateActiveSession() } }
                        .disabled(model.status == .validating)
                }
                Section("Local storage") {
                    LabeledContent("Retained drafts", value: String(model.retainedDraftCount))
                    LabeledContent("Database", value: "SQLite / GRDB")
                }
                if let message = model.message {
                    Section { Text(message).foregroundStyle(.red).textSelection(.enabled) }
                }
                Section {
                    Button("Sign out", role: .destructive) { model.logout() }
                } footer: {
                    Text("Sign out to change backend or account. Recovery records stay scoped to their original account.")
                }
            }
            .navigationTitle("Settings")
        }
    }
}
