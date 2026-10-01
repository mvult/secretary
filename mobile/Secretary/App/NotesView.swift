import SecretaryCore
import SwiftUI

struct JournalsView: View {
    @Bindable var model: NotesModel
    @State private var selectedDate = Date()
    @State private var showDatePicker = false
    @State private var openedDate: String?

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                let available = JournalDates.available(now: context.date)
                let today = JournalDates.key(context.date)
                List {
                    if let message = model.message { Text(message).font(.caption).foregroundStyle(.red) }
                    Section {
                        ForEach(available, id: \.self) { date in
                            journalLink(date, label: date == today ? "Today · \(date)" : date)
                        }
                    }
                    let recovery = model.editors.recovery.filter { $0.kind == "journal" }
                    if !recovery.isEmpty {
                        Section("Local drafts & recovery") {
                            ForEach(recovery) { draft in
                                NavigationLink(draft.journalDate) { EditorLoader(notes: model, key: draft.id) }
                            }
                        }
                    }
                    Section("Journals") {
                        ForEach(model.entries.filter { $0.kind == "journal" && !available.contains($0.journalDate) }
                            .sorted { $0.journalDate > $1.journalDate }, id: \.id) { entry in
                            journalLink(entry.journalDate, label: entry.journalDate)
                        }
                    }
                }
                .sheet(isPresented: $showDatePicker) {
                    NavigationStack {
                        Form {
                            DatePicker("Journal date", selection: $selectedDate,
                                in: ...JournalDates.date(available.last!)!, displayedComponents: .date)
                                .datePickerStyle(.graphical)
                            Button("Open journal") {
                                openedDate = JournalDates.key(selectedDate)
                                showDatePicker = false
                            }
                        }
                        .navigationTitle("Open date")
                        .toolbar { Button("Cancel") { showDatePicker = false } }
                    }
                }
            }
            .navigationTitle("Journals")
            .toolbar {
                Button("Open date", systemImage: "calendar.badge.plus") {
                    selectedDate = Date(); showDatePicker = true
                }.disabled(!model.enabled)
            }
            .navigationDestination(isPresented: Binding(get: { openedDate != nil }, set: { if !$0 { openedDate = nil } })) {
                if let openedDate { JournalLoader(notes: model, date: openedDate) }
            }
            .refreshable { await model.refresh(); try? await model.editors.refreshRecovery() }
            .task(id: model.enabled) {
                if model.enabled { await model.refresh(); await model.editors.resume() }
            }
        }
    }

    private func journalLink(_ date: String, label: String) -> some View {
        NavigationLink(label) { JournalLoader(notes: model, date: date) }
            .disabled(!model.enabled)
    }
}

private struct JournalLoader: View {
    @Bindable var notes: NotesModel
    let date: String
    @State private var editor: DocumentEditor?
    @State private var error: String?

    var body: some View {
        Group {
            if let editor { NoteEditorView(editor: editor, notes: notes) }
            else if let error {
                ContentUnavailableView {
                    Label("Unable to open journal", systemImage: "exclamationmark.triangle")
                } description: { Text(error) } actions: {
                    Button("Retry") { Task { await open() } }
                }
            } else { ProgressView("Opening journal") }
        }
        .task(id: notes.enabled) { if notes.enabled, editor == nil { await open() } }
    }

    private func open() async {
        do {
            editor = try await notes.editors.openJournal(date: date,
                existingID: notes.entries.first(where: { $0.kind == "journal" && $0.journalDate == date })?.id)
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct NotesView: View {
    @Bindable var model: NotesModel
    var body: some View {
        NavigationStack { DirectoryView(model: model, parent: 0) }
            .task(id: model.enabled) {
                if model.enabled {
                    await model.refresh()
                    await model.editors.resume()
                }
            }
    }
}

private struct DirectoryView: View {
    @Bindable var model: NotesModel
    let parent: Int64
    @State private var editing: FolderForm?
    @State private var deleting: Int64?
    @State private var created: DocumentEditor?
    @State private var creationError: String?
    @State private var creating = false
    private var folders: [Secretary_V1_Directory] {
        model.directories.filter { $0.parentID == parent }.sorted {
            $0.position == $1.position ? $0.id < $1.id : $0.position < $1.position
        }
    }
    private var notes: [Secretary_V1_DocumentIndexEntry] {
        model.entries.filter { $0.directoryID == parent && $0.kind == "note" }
    }
    var body: some View {
        List {
            if parent == 0, model.editors.recovery.contains(where: { $0.kind != "journal" }) {
                Section("Local drafts & recovery") {
                    ForEach(model.editors.recovery.filter { $0.kind != "journal" }) { draft in
                        NavigationLink(draft.title) {
                            EditorLoader(notes: model, key: draft.id)
                        }
                    }
                }
            }
            if let creationError { Text(creationError).foregroundStyle(.red) }
            if let message = model.message {
                Section { Text(message).foregroundStyle(.red); Button("Refresh") { Task { await model.refresh() } } }
            }
            if model.cachedIndex { Text("Cached folders and notes").font(.caption).foregroundStyle(.secondary) }
            if model.loading { ProgressView("Refreshing notes") }
            ForEach(folders, id: \.id) { folder in
                NavigationLink {
                    DirectoryView(model: model, parent: folder.id)
                } label: { Label(folder.name, systemImage: "folder") }
                .contextMenu {
                    Button("Rename") { editing = FolderForm(mode: .rename, directory: folder.id, name: folder.name, parent: folder.parentID) }
                    Button("Move") { editing = FolderForm(mode: .move, directory: folder.id, name: folder.name, parent: folder.parentID) }
                    Button("Delete empty folder", role: .destructive) { deleting = folder.id }
                        .disabled(!model.canDelete(folder.id))
                }.disabled(!model.enabled)
            }
            ForEach(notes, id: \.id) { note in
                NavigationLink { EditorLoader(notes: model, documentID: note.id) } label: {
                    Label(note.title.isEmpty ? "Untitled" : note.title, systemImage: "doc.text")
                }
            }
            if folders.isEmpty && notes.isEmpty && !model.loading {
                ContentUnavailableView("No notes", systemImage: "doc.text", description: Text("Notes added on desktop will appear here."))
            }
        }
        .navigationTitle(parent == 0 ? "Notes" : model.directories.first(where: { $0.id == parent })?.name ?? "Folder")
        .refreshable { await model.refresh() }
        .toolbar {
            Button("New note", systemImage: "square.and.pencil") {
                creating = true
                Task {
                    defer { creating = false }
                    do { created = try await model.editors.create(parent: parent) }
                    catch { creationError = error.localizedDescription }
                }
            }.disabled(!model.enabled || creating)
            Button("New folder", systemImage: "folder.badge.plus") {
                editing = FolderForm(mode: .create, directory: 0, name: "", parent: parent)
            }.disabled(!model.canMutate)
        }
        .sheet(item: $editing) { form in FolderEditor(model: model, form: form) }
        .navigationDestination(isPresented: Binding(get: { created != nil }, set: { if !$0 { created = nil } })) {
            if let created { NoteEditorView(editor: created, notes: model) }
        }
        .confirmationDialog("Delete this empty folder?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete folder", role: .destructive) {
                if let id = deleting { Task { await model.changeDirectory(.delete(id: id)) } }
                deleting = nil
            }.disabled(!model.canMutate)
        }
    }
}

private struct FolderForm: Identifiable {
    enum Mode { case create, rename, move }
    let id = UUID()
    let mode: Mode
    let directory: Int64
    var name: String
    var parent: Int64
}

private struct FolderEditor: View {
    @Bindable var model: NotesModel
    @State var form: FolderForm
    @Environment(\.dismiss) private var dismiss
    private var name: String { form.name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        NavigationStack {
            Form {
                if form.mode != .move { TextField("Folder name", text: $form.name) }
                if form.mode != .rename {
                    Picker("Parent folder", selection: $form.parent) {
                        Text("Root").tag(Int64(0))
                    ForEach(model.directories.filter { form.directory == 0 || !model.descendants(of: form.directory).contains($0.id) }, id: \.id) { directory in
                            Text(path(directory)).tag(directory.id)
                        }
                    }
                }
                if let message = model.message {
                    Text(message).foregroundStyle(.red)
                    Button("Refresh folders") { Task { await model.refresh() } }
                }
            }
            .navigationTitle(form.mode == .create ? "New folder" : form.mode == .rename ? "Rename folder" : "Move folder")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let action: NotesModel.DirectoryAction = switch form.mode {
                        case .create: .create(name: name, parent: form.parent)
                        case .rename: .rename(id: form.directory, name: name)
                        case .move: .move(id: form.directory, parent: form.parent)
                        }
                        Task { if await model.changeDirectory(action) { dismiss() } }
                    }.disabled(!model.canMutate || name.isEmpty)
                }
            }
            .interactiveDismissDisabled(model.mutating)
        }
    }
    private func path(_ directory: Secretary_V1_Directory) -> String {
        var names = [directory.name]; var parent = directory.parentID; var visited: Set<Int64> = [directory.id]
        while visited.insert(parent).inserted, let ancestor = model.directories.first(where: { $0.id == parent }) {
            names.insert(ancestor.name, at: 0); parent = ancestor.parentID
        }
        return names.joined(separator: " / ")
    }
}

struct TodoMarker: View {
    let status: String
    var body: some View {
        switch status {
        case "todo":
            Text("☐").foregroundStyle(.secondary).accessibilityLabel("To do")
        case "done":
            Text("☑").foregroundStyle(.green).accessibilityLabel("Completed")
        default:
            Text(status.uppercased()).font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct BlockText: View {
    let text: String
    let completed: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                let hashes = line.prefix(while: { $0 == "#" }).count
                let isHeading = (1...6).contains(hashes) && line.dropFirst(hashes).first == " "
                let level = isHeading ? hashes : 0
                let content = isHeading ? String(line.dropFirst(hashes + 1)) : line
                Text(content.isEmpty ? " " : content)
                    .font(font(for: level))
                    .strikethrough(completed)
                    .foregroundStyle(completed ? .secondary : .primary)
                    .accessibilityAddTraits(isHeading ? .isHeader : [])
            }
        }
        .textSelection(.enabled)
    }

    private func font(for level: Int) -> Font {
        switch level {
        case 1: .title2.bold()
        case 2: .title3.bold()
        case 3: .headline
        case 4: .subheadline.bold()
        case 5: .footnote.bold()
        case 6: .caption.bold()
        default: .body
        }
    }
}
