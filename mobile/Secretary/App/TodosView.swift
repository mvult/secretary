import SecretaryCore
import SwiftUI

struct TodosView: View {
    @Bindable var model: TodosModel
    @Bindable var notes: NotesModel
    @State private var creating = false

    var body: some View {
        NavigationStack {
            List {
                Picker("Status", selection: $model.filter) {
                    ForEach(TodoFilter.allCases) { filter in Text(filter.rawValue.capitalized).tag(filter) }
                }.pickerStyle(.segmented)
                if let message = model.message { Text(message).font(.caption).foregroundStyle(.red) }
                if model.cached { Text("Cached TODOs · refresh before editing").font(.caption).foregroundStyle(.secondary) }
                if !model.pending.isEmpty {
                    Section("Retained requests") {
                        ForEach(model.pending, id: \.mutationID) { operation in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(operation.kind.rawValue).font(.caption)
                                Text(model.retainedName(operation))
                                if model.rejected.contains(operation.mutationID) {
                                    Text("Rejected by the server. Discard this request, refresh, and edit again.").font(.caption)
                                    Button("Discard rejected request", role: .destructive) {
                                        Task { await model.discardRejected(operation) }
                                    }
                                } else {
                                    Button("Retry retained request") { Task { await model.retry(operation) } }
                                }
                            }.disabled(model.busy || !model.enabled)
                        }
                    }
                }
                Section {
                    ForEach(model.visible, id: \.id) { todo in
                        NavigationLink {
                            TodoForm(model: model, notes: notes, original: todo)
                        } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Text(todo.status == .done ? "☑" : "☐").foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(todo.name).strikethrough(todo.status == .done)
                                    if !todo.desc.isEmpty { Text(todo.desc).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                                    Text(todo.status.mobileLabel).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    if model.visible.isEmpty, !model.busy { Text("No TODOs").foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("My TODOs")
            .toolbar {
                if model.busy { ProgressView().controlSize(.small) }
                Button("New TODO", systemImage: "plus") { creating = true }.disabled(!model.canMutate)
            }
            .sheet(isPresented: $creating) {
                NavigationStack { TodoForm(model: model, notes: notes, original: nil) }
            }
            .refreshable { await model.refresh() }
            .task(id: model.enabled) { if model.enabled { await model.refresh() } }
            .onAppear { Task { await model.refresh() } }
        }
    }

}

private struct TodoForm: View {
    @Bindable var model: TodosModel
    @Bindable var notes: NotesModel
    let original: Secretary_V1_Todo?
    @State private var name: String
    @State private var description: String
    @State private var status: Secretary_V1_TodoStatus
    @State private var deleting = false
    @Environment(\.dismiss) private var dismiss

    init(model: TodosModel, notes: NotesModel, original: Secretary_V1_Todo?) {
        self.model = model; self.notes = notes; self.original = original
        _name = State(initialValue: original?.name ?? "")
        _description = State(initialValue: original?.desc ?? "")
        _status = State(initialValue: original?.status ?? .todo)
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, axis: .vertical)
                TextField("Description", text: $description, axis: .vertical).lineLimit(3...10)
                Picker("Status", selection: $status) {
                    ForEach([Secretary_V1_TodoStatus.todo, .doing, .done, .blocked, .skipped], id: \.rawValue) { value in
                        Text(value.mobileLabel).tag(value)
                    }
                }
            }.disabled(!model.canMutate)
            if let original {
                Section("Source") {
                    if original.sourceDocumentID > 0 {
                        NavigationLink("Source document #\(original.sourceDocumentID)") {
                            EditorLoader(notes: notes, documentID: original.sourceDocumentID)
                        }
                        if original.sourceBlockID > 0 { Text("Block #\(original.sourceBlockID)").font(.caption) }
                    }
                    if original.currentDocumentID > 0, original.currentDocumentID != original.sourceDocumentID {
                        NavigationLink("Current document #\(original.currentDocumentID)") {
                            EditorLoader(notes: notes, documentID: original.currentDocumentID)
                        }
                    }
                    if !original.createdAtRecordingName.isEmpty { Text(original.createdAtRecordingName) }
                    if original.sourceDocumentID == 0, original.createdAtRecordingName.isEmpty { Text("Standalone TODO").foregroundStyle(.secondary) }
                }
                if model.canDelete {
                    Button("Delete TODO", role: .destructive) { deleting = true }.disabled(!model.canMutate)
                }
            }
            if let message = model.message { Text(message).foregroundStyle(.red).font(.caption) }
            if !model.pending.isEmpty { Text("Request retained. Resolve it from My TODOs before submitting another change.").font(.caption) }
        }
        .navigationTitle(original == nil ? "New TODO" : "Edit TODO")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if original == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            ToolbarItem(placement: .confirmationAction) {
                if model.busy { ProgressView().controlSize(.small) }
                else {
                    Button("Save") {
                        Task {
                            if await model.save(original: original, name: name, description: description, status: status) { dismiss() }
                        }
                    }.disabled(!model.canMutate || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .confirmationDialog("Delete this TODO?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete TODO", role: .destructive) {
                if let original { Task { if await model.delete(original) { dismiss() } } }
            }
        }
    }
}

private extension Secretary_V1_TodoStatus {
    var mobileLabel: String {
        switch self {
        case .todo: "Todo"
        case .doing: "Doing"
        case .done: "Done"
        case .blocked: "Blocked"
        case .skipped: "Skipped"
        default: "Unknown"
        }
    }
}
