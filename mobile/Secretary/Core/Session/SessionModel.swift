import Connect
import Foundation
import Observation

@MainActor @Observable
public final class SessionModel {
    public enum Status: String { case restoring, signedOut, validating, ready, reauthenticationRequired, unavailable }
    public private(set) var status: Status = .restoring
    public private(set) var session: ValidatedSession?
    public private(set) var message: String?
    public private(set) var retainedDraftCount = 0
    public private(set) var backendURL: String
    public let notes: NotesModel
    public let todos: TodosModel
    public var validatedCredentials: Credentials? { status == .ready ? activeCredentials : nil }

    private let api: any SessionAPI
    private let credentials: any CredentialStore
    private let drafts: DraftRepository
    private let preferences: UserDefaults
    private var activeCredentials: Credentials?
    private var epoch = 0

    public init(api: any SessionAPI, credentials: any CredentialStore,
                drafts: DraftRepository, preferences: UserDefaults = .standard) {
        self.api = api
        self.credentials = credentials
        self.drafts = drafts
        notes = NotesModel(api: BackendAPI(), store: drafts)
        todos = TodosModel(store: drafts)
        self.preferences = preferences
        backendURL = preferences.string(forKey: "backendURL") ?? AppConfiguration.defaultBackendURL
        notes.onAuthenticationFailure = { [weak self] in
            guard let self else { return }
            self.notes.suspend()
            self.todos.suspend()
            self.status = .reauthenticationRequired
            self.message = "Your session expired. Sign out and sign in again."
        }
        todos.onAuthenticationFailure = { [weak self] in self?.notes.onAuthenticationFailure?() }
        notes.editors.onChange = { [weak self] in
            guard let self else { return }
            await self.notes.refresh()
            await self.todos.refresh()
        }
        todos.onMutation = { [weak self] in
            guard let self else { return }
            await self.notes.editors.refreshAfterTodoMutation()
            await self.notes.refresh()
        }
    }

    public func restore() async {
        guard status == .restoring else { return }
        do {
            guard let stored = try credentials.load() else { status = .signedOut; return }
            activeCredentials = stored
            backendURL = stored.backend.rawValue
            await validateActiveSession()
        } catch { fail(error) }
    }

    public func login(backendURL: String, email: String, password: String) async {
        epoch += 1
        let attempt = epoch
        notes.clear()
        todos.clear()
        status = .validating
        session = nil
        retainedDraftCount = 0
        message = nil
        // An explicit login can switch accounts/backends. Don't leave the old token
        // available for restoration if the new login or Keychain write fails.
        activeCredentials = nil
        do {
            try credentials.clear()
            let backend = try BackendAddress(backendURL)
            self.backendURL = backend.rawValue
            preferences.set(backend.rawValue, forKey: "backendURL")
            let candidate = try await api.login(backend: backend,
                email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            guard attempt == epoch else { return }
            let validated = try await api.validate(candidate)
            guard attempt == epoch else { return }
            let count = try await drafts.retainedDraftCount(scope: validated.scope)
            guard attempt == epoch else { return }
            try credentials.save(candidate)
            activeCredentials = candidate
            session = validated
            retainedDraftCount = count
            status = .ready
            notes.activate(candidate)
            todos.activate(candidate)
        } catch {
            guard attempt == epoch else { return }
            fail(error)
        }
    }

    public func validateActiveSession() async {
        guard status != .validating, let candidate = activeCredentials else { return }
        epoch += 1
        let attempt = epoch
        status = .validating
        message = nil
        notes.suspend()
        todos.suspend()
        do {
            let validated = try await api.validate(candidate)
            guard attempt == epoch else { return }
            let count = try await drafts.retainedDraftCount(scope: validated.scope)
            guard attempt == epoch else { return }
            session = validated
            retainedDraftCount = count
            status = .ready
            notes.activate(candidate)
            todos.activate(candidate)
        } catch {
            guard attempt == epoch else { return }
            fail(error)
        }
    }

    public func logout() {
        notes.clear()
        todos.clear()
        epoch += 1
        session = nil
        activeCredentials = nil
        retainedDraftCount = 0
        message = nil
        do { try credentials.clear(); status = .signedOut }
        catch { status = .unavailable; message = error.localizedDescription }
    }

    private func fail(_ error: Error) {
        message = error.localizedDescription
        status = (error as? ConnectError)?.code == .unauthenticated ? .reauthenticationRequired : .unavailable
    }
}
