from textual.app import App, ComposeResult
from textual.containers import Container
from textual.widgets import Header, Static, Footer
import logging

from db.connection import init_database, close_database
from ui.recorder_widget import RecorderWidget
from ui.recordings_list_widget import RecordingsListWidget
from components.import_modal import ImportRecordingModal
from services.import_service import RecordingImporter

# Set up logging (file only to avoid cluttering TUI)
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.FileHandler("tui_debug.log")],
)

# Disable tortoise db_client debug logs
logging.getLogger("tortoise.db_client").setLevel(logging.INFO)


class RecordingApp(App):
    """Main TUI application for recording management"""

    TITLE = "Secretary"

    CSS = """
    Container {
        height: 100%;
    }
    
    RecorderWidget {
        height: 5;
        margin: 0;
        padding: 0;
    }
    
    RecordingsListWidget {
        height: auto;
        max-height: 1fr;
        margin: 0;
        padding: 0;
    }

    #app-message {
        min-height: 1;
        padding: 0 1;
        color: $text;
    }

    .status-error {
        color: red;
    }
    """

    BINDINGS = [
        ("r", "start_recording", "Start Recording"),
        ("s", "stop_recording", "Stop Recording"),
        ("q,ctrl+c", "quit", "Quit"),
        ("f", "refresh_list", "Refresh List"),
        ("i", "import_recording", "Import local audio"),
    ]

    def __init__(self):
        super().__init__()
        self.db_connected = False
        self.recorder_widget = RecorderWidget()
        self.recordings_list_widget = RecordingsListWidget()
        self.recording_importer = RecordingImporter()

    async def on_mount(self) -> None:
        """Initialize the application"""
        # Try to connect to database
        self.db_connected = await init_database()
        self.recordings_list_widget.set_db_connected(self.db_connected)

    def compose(self) -> ComposeResult:
        """Create the UI layout"""
        yield Header()

        with Container():
            yield Static("", id="spacer")  # Add spacer to push content down
            yield self.recorder_widget
            yield Static("", id="app-message")

            yield self.recordings_list_widget

            yield Footer()

    async def on_ready(self) -> None:
        """Setup after UI is ready"""
        # Load recordings after UI is ready
        if self.db_connected:
            await self.recordings_list_widget.refresh_recordings_list()

    async def action_start_recording(self) -> None:
        """Start recording"""
        recording_id = await self.recorder_widget.start_recording()
        # Skip list refresh here so the audio loop starts immediately
        _ = recording_id

    async def action_stop_recording(self) -> None:
        """Stop recording"""
        success = await self.recorder_widget.stop_recording()
        # Refresh recordings list if stopped successfully
        if success and self.db_connected:
            await self.recordings_list_widget.refresh_recordings_list()

    async def action_refresh_list(self) -> None:
        """Refresh recordings list"""
        if self.db_connected:
            await self.recordings_list_widget.refresh_recordings_list()

    async def action_import_recording(self) -> None:
        """Import an existing local audio file"""
        if not self.db_connected:
            self._set_status_message("Database unavailable", error=True)
            return

        self.push_screen(ImportRecordingModal(), callback=self._handle_import_modal)

    async def _handle_import_modal(self, result) -> None:
        if not result or "path" not in result:
            return

        self._set_status_message("Importing...", error=False)
        import_result = await self.recording_importer.import_file(result["path"])

        if import_result.get("success"):
            self._set_status_message("Import complete", error=False)
            await self.recordings_list_widget.refresh_recordings_list()
        else:
            message = import_result.get("error", "Unknown error")
            self._set_status_message(f"Import failed: {message}", error=True)

    def _set_status_message(self, message: str, *, error: bool = False) -> None:
        try:
            widget = self.query_one("#app-message", Static)
        except Exception:
            return

        widget.update(message)
        widget.set_class(error, "status-error")

    async def on_unmount(self) -> None:
        """Cleanup when app closes"""
        if self.recorder_widget.get_recording_status():
            await self.recorder_widget.stop_recording()

        if self.db_connected:
            await close_database()


if __name__ == "__main__":
    app = RecordingApp()
    app.run()
