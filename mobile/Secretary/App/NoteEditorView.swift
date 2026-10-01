import SecretaryCore
import SwiftUI

struct EditorLoader: View {
    @Bindable var notes: NotesModel
    var documentID: Int64?
    var key: String?
    @State private var editor: DocumentEditor?
    @State private var error: String?

    var body: some View {
        Group {
            if let editor { NoteEditorView(editor: editor, notes: notes) }
            else if let error {
                ContentUnavailableView {
                    Label("Unable to open note", systemImage: "exclamationmark.triangle")
                } description: { Text(error) } actions: {
                    Button("Retry") { Task { await open() } }
                }
            } else { ProgressView("Opening note") }
        }.task { await open() }
    }
    private func open() async {
        do { editor = try await notes.editors.open(id: documentID, key: key); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct NoteEditorView: View {
    @Bindable var editor: DocumentEditor
    @Bindable var notes: NotesModel
    @FocusState private var focused: String?
    @State private var editingBlock: String?
    @State private var deleting = false
    @State private var review = false
    @State private var moving = false
    @State private var recoveryCopy: DocumentEditor?
    @State private var copyError: String?
    @State private var reloading = false
    @State private var archiving = false
    @State private var saveDetails = false
    @ScaledMetric(relativeTo: .caption2) private var statusHeight = 18
    @ScaledMetric(relativeTo: .caption2) private var statusWidth = 90

    var body: some View {
        List {
            Section {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    TextField("Title", text: Binding(get: { editor.document.title }, set: { title in
                        editor.change { $0.title = title }
                    }), axis: .vertical)
                        .font(.title2.bold()).disabled(!editor.editable)
                        .focused($focused, equals: "_title")
                        .accessibilityIdentifier("noteTitle")
                    Button { saveDetails = true } label: {
                        HStack(spacing: 4) {
                            if editor.reloading { ProgressView().controlSize(.mini) }
                            Text(saveStatus)
                        }
                            .font(.caption2)
                            .foregroundStyle(saveNeedsAttention ? Color.red : Color.secondary.opacity(0.65))
                            .lineLimit(1)
                            .frame(width: statusWidth, height: statusHeight, alignment: .trailing)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Show save details and recovery actions")
                    .transaction { $0.animation = nil }
                }
            }
            if editor.stored.deleted != true {
                ForEach(editor.document.blocks, id: \.clientKey) { block in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(.secondary).frame(width: 8).accessibilityHidden(true)
                        if !block.todoStatus.isEmpty { TodoMarker(status: block.todoStatus) }
                        if editingBlock == block.clientKey {
                            TextField("Block text", text: binding(block.clientKey), axis: .vertical)
                                .focused($focused, equals: block.clientKey)
                                .onAppear { focused = block.clientKey }
                                .accessibilityIdentifier("blockEditor")
                        } else {
                            BlockText(text: block.text.isEmpty ? "Tap to edit" : block.text, completed: block.todoStatus == "done")
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                                .onTapGesture { editingBlock = block.clientKey }
                        }
                    }
                    .padding(.leading, CGFloat(min(editor.depth(of: block.clientKey), 12)) * 16)
                    .disabled(!editor.editable)
                    .contextMenu {
                        Menu("TODO status") {
                            ForEach(["", "todo", "doing", "done", "blocked", "skipped"], id: \.self) { status in
                                Button(status.isEmpty ? "No TODO" : status.capitalized) {
                                    editor.change { document in
                                        if let index = document.blocks.firstIndex(where: { $0.clientKey == block.clientKey }) {
                                            document.blocks[index].todoStatus = status
                                        }
                                    }
                                }
                            }
                        }
                        Button("Cycle TODO state", systemImage: "checklist") {
                            editor.modifyBlock(block.clientKey, action: .cycleTodo)
                        }
                        Button("Add block below") { editingBlock = editor.addBlock(after: block.clientKey) }
                        Button("Indent") { editor.modifyBlock(block.clientKey, action: .indent) }
                        Button("Outdent") { editor.modifyBlock(block.clientKey, action: .outdent) }
                        Button("Move up") { editor.modifyBlock(block.clientKey, action: .up) }
                        Button("Move down") { editor.modifyBlock(block.clientKey, action: .down) }
                        Button("Delete block and children", role: .destructive) {
                            focused = nil; editingBlock = nil; editor.modifyBlock(block.clientKey, action: .delete)
                        }
                    }
                }
                if editor.document.blocks.isEmpty {
                    Button("Add first block", systemImage: "plus") { editingBlock = editor.addBlock() }
                        .disabled(!editor.editable)
                }
            }
        }
        .navigationTitle(editor.document.title.isEmpty ? "Untitled" : editor.document.title)
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .task(id: notes.enabled) { if notes.enabled { await editor.resume() } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Save now", systemImage: "arrow.triangle.2.circlepath") { Task { await editor.save() } }
                        .disabled(editor.saving || editor.storageFailed || !notes.enabled)
                    if editor.document.kind == "note" {
                        Button("Move note", systemImage: "folder") { moving = true }.disabled(!editor.editable)
                    }
                    ShareLink("Export text", item: exportText)
                    Button("Reload from server", systemImage: "arrow.clockwise") {
                        if editor.stored.dirty || editor.persisting || editor.stored.conflict != nil {
                            reloading = true
                        } else { reloadFromServer() }
                    }
                        .disabled(editor.saving || editor.storageFailed || editor.document.id == 0 || (editor.stored.pending != nil && editor.stored.rejected != true) || !notes.enabled)
                    if editor.stored.conflict != nil || editor.document.id == 0 {
                        Button("Archive local recovery", systemImage: "archivebox") { archiving = true }
                            .disabled(editor.saving || editor.storageFailed || (editor.stored.pending != nil && editor.stored.rejected != true))
                    }
                    if editor.document.kind == "note" {
                        Button("Delete note", systemImage: "trash", role: .destructive) { deleting = true }
                            .disabled(editor.saving || editor.persisting || editor.storageFailed || editor.stored.dirty || editor.stored.pending != nil || editor.stored.conflict != nil || editor.document.id == 0 || !notes.enabled || !editor.editable)
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                .disabled(editor.reloading)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focused = nil; editingBlock = nil }
            }
        }
        .confirmationDialog("Delete this note?", isPresented: $deleting) {
            Button("Delete note", role: .destructive) { focused = nil; Task { await editor.save(deleting: true) } }
        } message: { Text("The deletion will be retained locally until the server confirms it.") }
        .confirmationDialog("Discard unsaved edits?", isPresented: $reloading, titleVisibility: .visible) {
            Button("Discard edits", role: .destructive) { reloadFromServer() }
        } message: {
            Text("Your local changes will be replaced with the latest server copy.")
        }
        .confirmationDialog("Archive this local recovery?", isPresented: $archiving) {
            Button("Archive recovery", role: .destructive) {
                focused = nil; editingBlock = nil
                Task { await editor.archiveRecovery() }
            }
        } message: { Text("This hides the recovery from the list without deleting the server note. The local snapshot remains in storage.") }
        .sheet(isPresented: $moving) {
            NavigationStack {
                List {
                    Button("Root") { move(to: 0) }
                    ForEach(notes.directories, id: \.id) { directory in
                        Button(directoryPath(directory)) { move(to: directory.id) }
                    }
                }.navigationTitle("Move note")
                    .toolbar { Button("Cancel") { moving = false } }
            }
        }
        .sheet(isPresented: $saveDetails) {
            NavigationStack {
                List {
                    Text(editor.status)
                    if let error = editor.error ?? editor.stored.lastError { Text(error).foregroundStyle(.red) }
                    if let copyError { Text(copyError).foregroundStyle(.red) }
                    if editor.storageFailed {
                        Button("Retry local storage") { Task { await editor.retryLocalStorage() } }
                        ShareLink("Export unsaved text", item: exportText)
                    } else if let conflict = editor.stored.conflict {
                        Text(conflict).foregroundStyle(.orange)
                        Button("Review conflict") { review = true; Task { await editor.review() } }
                        Button("Save a recovery copy") { makeCopy() }
                    } else if !editor.saving, editor.stored.pending != nil || editor.error != nil || editor.stored.lastError != nil {
                        Button("Retry retained save") { Task { await editor.save() } }
                            .disabled(!notes.enabled)
                    }
                }
                .navigationTitle("Save details")
                .toolbar { Button("Close") { saveDetails = false } }
                .sheet(isPresented: $review) { ConflictView(editor: editor) }
            }
        }
        .navigationDestination(isPresented: Binding(get: { recoveryCopy != nil }, set: { if !$0 { recoveryCopy = nil } })) {
            if let recoveryCopy { NoteEditorView(editor: recoveryCopy, notes: notes) }
        }
    }

    private var saveNeedsAttention: Bool {
        !editor.reloading && (editor.storageFailed || editor.stored.conflict != nil || copyError != nil ||
            (!editor.saving && (editor.error != nil || editor.stored.lastError != nil)))
    }
    private var saveStatus: String {
        if editor.reloading { return "Reloading…" }
        if saveNeedsAttention { return "Save issue" }
        if editor.stored.deleted == true { return "Deleted" }
        if editor.stored.archived == true { return "Archived locally" }
        if editor.persisting || editor.saving { return "Saving…" }
        if editor.stored.pending != nil || editor.stored.dirty { return "Saved locally" }
        return "Saved"
    }

    private var exportText: String { ([editor.document.title] + editor.document.blocks.map { String(repeating: "  ", count: editor.depth(of: $0.clientKey)) + "• " + $0.text }).joined(separator: "\n") }
    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.document.blocks.first(where: { $0.clientKey == key })?.text ?? "" }, set: { text in
            editor.change { document in
                if let index = document.blocks.firstIndex(where: { $0.clientKey == key }) { document.blocks[index].text = text }
            }
        })
    }
    private func move(to directory: Int64) { editor.change { $0.directoryID = directory }; moving = false }
    private func reloadFromServer() {
        focused = nil; editingBlock = nil
        Task { await editor.reloadFromServer() }
    }
    private func makeCopy() {
        Task {
            do {
                recoveryCopy = try await notes.editors.create(parent: 0, copy: editor)
                saveDetails = false
            }
            catch { copyError = error.localizedDescription }
        }
    }
    private func directoryPath(_ directory: Secretary_V1_Directory) -> String {
        var names = [directory.name]; var parent = directory.parentID; var seen: Set<Int64> = [directory.id]
        while seen.insert(parent).inserted, let folder = notes.directories.first(where: { $0.id == parent }) {
            names.insert(folder.name, at: 0); parent = folder.parentID
        }
        return names.joined(separator: " / ")
    }
}

private struct ConflictView: View {
    @Bindable var editor: DocumentEditor
    @Environment(\.dismiss) private var dismiss
    @State private var reload = false
    private var server: Secretary_V1_Document? { editor.stored.serverCopy.flatMap { try? DocumentRules.decode($0) } }
    var body: some View {
        NavigationStack {
            List {
                Section("Your retained draft") { Text(text(editor.document)).textSelection(.enabled) }
                Section("Server copy") {
                    if let server {
                        Text("Revision \(server.revision)").font(.caption)
                        Text(text(server)).textSelection(.enabled)
                    } else { Text(editor.stored.serverMissing == true ? "Deleted on the server" : "Server copy unavailable") }
                    Button("Refresh server copy") { Task { await editor.review() } }
                }
                Section {
                    Button("Save my draft against reviewed revision") {
                        Task { await editor.resolve(useServer: false); if editor.stored.conflict == nil { dismiss() } }
                    }.disabled(server == nil || editor.saving || editor.storageFailed)
                    Button("Discard my edits and use server", role: .destructive) { reload = true }
                        .disabled(server == nil || editor.saving || editor.storageFailed)
                }
                if let error = editor.error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Resolve conflict")
            .toolbar { Button("Close") { dismiss() } }
            .confirmationDialog("Discard your local edits?", isPresented: $reload) {
                Button("Use server copy", role: .destructive) {
                    Task { await editor.resolve(useServer: true); if editor.stored.conflict == nil { dismiss() } }
                }
            }
        }
    }
    private func text(_ document: Secretary_V1_Document) -> String {
        ([document.title] + document.blocks.map(\.text)).joined(separator: "\n")
    }
}
