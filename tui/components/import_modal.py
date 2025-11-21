from textual.app import ComposeResult
from textual.containers import Container
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Static


class ImportRecordingModal(ModalScreen):
    """Modal dialog for importing an existing audio file."""

    CSS = """
    ImportRecordingModal {
        align: center middle;
    }

    .import-dialog {
        width: 70;
        height: 15;
        background: $surface;
        border: solid $primary;
        padding: 2;
    }

    .dialog-title {
        text-style: bold;
        height: auto;
    }

    .dialog-subtitle {
        color: $text-muted;
        height: auto;
        padding-bottom: 1;
    }

    #file-path-input {
        width: 100%;
        height: 3;
        margin: 1 0;
        border: solid $primary;
    }

    .button-row {
        width: 100%;
        height: 3;
        align-horizontal: right;
    }
    """

    def compose(self) -> ComposeResult:
        with Container(classes="import-dialog"):
            yield Static("Import an existing recording", classes="dialog-title")
            yield Static(
                "Provide the local file path (wav or m4a).",
                classes="dialog-subtitle",
            )
            yield Input(placeholder="/path/to/audio.m4a", id="file-path-input")
            with Container(classes="button-row"):
                yield Button("Cancel", id="cancel-btn")
                yield Button("Import", id="import-btn", variant="primary")

    async def on_mount(self) -> None:
        """Focus the path input once the modal is mounted."""
        self.set_timer(0.05, self._focus_path_input)

    def _focus_path_input(self) -> None:
        path_input = self.query_one("#file-path-input", Input)
        path_input.focus()

    async def _submit(self) -> None:
        path_input = self.query_one("#file-path-input", Input)

        file_path = path_input.value.strip()
        if not file_path:
            path_input.placeholder = "File path is required"
            path_input.focus()
            return

        self.dismiss({"path": file_path})

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "import-btn":
            await self._submit()
        else:
            self.dismiss(None)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "file-path-input":
            await self._submit()
        else:
            await self._submit()
