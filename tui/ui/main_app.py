from textual.app import App, ComposeResult
from textual.containers import Container
from textual.widgets import Header, Static, Footer
from textual.reactive import reactive
import asyncio
import logging

from db.connection import init_database, close_database
from ui.recorder_widget import RecorderWidget
from ui.recordings_list_widget import RecordingsListWidget

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
    """

    BINDINGS = [
        ("r", "start_recording", "Start Recording"),
        ("s", "stop_recording", "Stop Recording"),
        ("q,ctrl+c", "quit", "Quit"),
        ("f", "refresh_list", "Refresh List"),
    ]

    def __init__(self):
        super().__init__()
        self.db_connected = False
        self.recorder_widget = RecorderWidget()
        self.recordings_list_widget = RecordingsListWidget()

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
        # Refresh list if recording started successfully
        if recording_id and self.db_connected:
            await self.recordings_list_widget.refresh_recordings_list()

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

    async def on_unmount(self) -> None:
        """Cleanup when app closes"""
        if self.recorder_widget.get_recording_status():
            await self.recorder_widget.stop_recording()

        if self.db_connected:
            await close_database()


if __name__ == "__main__":
    app = RecordingApp()
    app.run()
