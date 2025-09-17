from textual.widgets import DataTable, Static
from textual.containers import Container
from typing import Optional
import logging
from db.service import RecordingService, AnalysisService


class RecordingsListWidget(Container):
    """Widget for displaying and managing recordings list"""

    CSS = """
    RecordingsListWidget {
        height: auto;
        min-height: 10;
    }
    
    .section-header {
        height: 1;
        padding: 0 1;
    }
    """

    BINDINGS = [
        ("enter,right", "open_recording", "Open Recording"),
    ]

    def __init__(self, db_connected: bool = False):
        super().__init__()
        self.db_connected = db_connected

    def compose(self):
        """Create recordings list UI components"""
        yield Static("Recordings List - Use ↑↓ to navigate", classes="section-header")
        yield DataTable(id="recordings-table")

    def on_mount(self):
        """Initialize the table"""
        table = self.query_one("#recordings-table", DataTable)
        table.add_columns("ID", "Name", "Duration", "Created", "Storage", "Analysis", "Status")
        table.cursor_type = "row"
        table.zebra_stripes = True
        table.focus()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle row selection in recordings table"""
        # Row is now selected - user can use P, A, Delete keys
        pass

    def get_selected_recording_id(self) -> Optional[int]:
        """Get the ID of the currently selected recording"""
        table = self.query_one("#recordings-table", DataTable)
        if table.cursor_row is not None:
            try:
                row_key = table.coordinate_to_cell_key(table.cursor_coordinate)
                row_data = table.get_row(row_key.row_key)
                return int(row_data[0])  # ID is first column
            except Exception as e:
                logging.error(f"Error getting selected recording ID: {e}")
                return None
        return None

    def select_recording(self):
        """Select the current recording for actions"""
        try:
            recording_id = self.get_selected_recording_id()
            if recording_id is None:
                logging.warning("No recording selected")
                return None

            logging.info(f"Selecting recording ID: {recording_id}")
            self.selected_recording_id = recording_id
            return recording_id

        except Exception as e:
            logging.error(f"Error selecting recording: {e}", exc_info=True)
            return None

    def deselect_recording(self):
        """Deselect the current recording"""
        logging.info("Deselecting recording")
        self.selected_recording_id = None

    async def refresh_recordings_list(self):
        """Refresh the recordings table"""
        if not self.db_connected:
            return

        recordings = await RecordingService.get_all_recordings()
        table = self.query_one("#recordings-table", DataTable)

        # Ensure columns are set up
        if len(table.columns) == 0:
            table.add_columns("ID", "Name", "Duration", "Created", "Storage", "Analysis", "Status")
            table.cursor_type = "row"
            table.zebra_stripes = True

        # Clear existing rows (but keep columns)
        table.clear(columns=False)

        # Add recordings
        for recording in recordings:
            duration_str = (
                recording.duration_formatted if recording.duration else "Unknown"
            )
            created_str = (
                recording.created_at_formatted if recording.created_at else "Unknown"
            )
            storage_str = recording.storage_status
            analysis_str = await AnalysisService.get_analysis_status(recording)
            status = "Archived" if recording.archived else "Active"

            try:
                table.add_row(
                    str(recording.id), recording.name, duration_str, created_str, storage_str, analysis_str, status
                )
            except Exception as e:
                logging.error(f"Error adding row to table: {e}")

    async def archive_recording(self, recording_id: int):
        """Archive the specified recording"""
        if self.db_connected:
            await RecordingService.archive_recording(recording_id)
            self.deselect_recording()
            await self.refresh_recordings_list()

    async def delete_recording(self, recording_id: int):
        """Delete the specified recording"""
        if self.db_connected:
            # TODO: Add confirmation dialog
            await RecordingService.delete_recording(recording_id)
            self.deselect_recording()
            await self.refresh_recordings_list()

    def set_db_connected(self, connected: bool):
        """Update database connection status"""
        self.db_connected = connected

    def action_open_recording(self):
        """Open the selected recording in detail screen"""
        recording_id = self.get_selected_recording_id()
        if recording_id:
            from ui.recording_detail_screen import RecordingDetailScreen

            self.app.push_screen(RecordingDetailScreen(recording_id))

