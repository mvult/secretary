from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal, Vertical
from textual.widgets import Header, DataTable, Static, Input
from textual.binding import Binding
from textual import events
from textual.reactive import reactive
import asyncio
import logging
from typing import Optional

from db.connection import init_database, close_database
from db.service import RecordingService
from recording.recorder import AudioRecorder

# Set up logging (file only to avoid cluttering TUI)
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('tui_debug.log')
    ]
)

class RecordingApp(App):
    """Main TUI application for recording management"""
    
    CSS = """
    .recording-status {
        height: 1;
        text-align: left;
        padding: 0 1;
    }
    
    .recording-controls {
        height: 3;
        padding: 1;
    }
    
    .recordings-list {
        height: 1fr;
        max-height: 1fr;
    }
    
    .process-controls {
        height: 3;
        padding: 1;
        margin-top: 1;
    }
    
    #instructions {
        height: 1;
        width: 100%;
        text-align: center;
        background: $surface;
        color: $primary;
        border: solid $primary;
    }
    
    
    .status-recording {
        color: red;
    }
    
    .status-ready {
        color: green;
    }
    """
    
    BINDINGS = [
        Binding("r", "start_recording", "Start Recording"),
        Binding("s", "stop_recording", "Stop Recording"),
        Binding("q", "quit", "Quit"),
        Binding("f", "refresh_list", "Refresh List"),
        Binding("right", "open_recording", "Open Recording"),
        Binding("left,escape", "close_recording", "Close Recording"),
        Binding("p", "process_recording", "Process"),
        Binding("a", "archive_recording", "Archive"),
        Binding("delete", "delete_recording", "Delete"),
        Binding("n", "focus_name_input", "Name Input"),
    ]
    
    is_recording = reactive(False)
    current_duration = reactive("00:00")
    selected_recording_id = reactive(None)
    instructions_text = reactive("Controls: [R]ecord [S]top [F]refresh [→] select [Q]uit")
    
    def watch_selected_recording_id(self, old_value, new_value):
        """React to changes in selected recording ID"""
        logging.info(f"Recording ID changed from {old_value} to {new_value}")
        # Schedule the update for the next cycle
        self.set_timer(0.01, self.update_instructions)
    
    def __init__(self):
        super().__init__()
        self.recorder = AudioRecorder()
        self.db_connected = False
    
    async def on_mount(self) -> None:
        """Initialize the application"""
        # Try to connect to database
        self.db_connected = await init_database()
        
        # Start recording timer
        self.set_interval(1.0, self.update_recording_timer)
    
    def compose(self) -> ComposeResult:
        """Create the UI layout"""
        yield Header()
        
        with Container():
            # Compact recording status
            yield Static("Ready", id="recording-status", classes="recording-status status-ready")
            
            # Recording controls
            with Vertical(classes="recording-controls"):
                yield Static("Duration: 00:00", id="duration-display")
                yield Input(placeholder="Recording name (optional) - Press [N] to focus", id="recording-name")
            
            # Recordings list
            with Container(classes="recordings-list"):
                yield Static("Recordings List - Use ↑↓ to navigate", classes="section-header")
                yield DataTable(id="recordings-table")
            
            # Instructions
            with Container(classes="process-controls"):
                yield Static("Controls: [R]ecord [S]top [F]refresh [→] select [Q]uit", id="instructions")
        
        # Footer removed - using custom instructions instead
    
    async def on_ready(self) -> None:
        """Setup after UI is ready"""
        table = self.query_one("#recordings-table", DataTable)
        table.add_columns("ID", "Name", "Duration", "Created", "Status")
        table.cursor_type = "row"
        table.zebra_stripes = True
        
        # Focus the table initially
        table.focus()
        
        # Update initial status
        self.update_recording_status()
        
        # Manually set the instructions initially
        try:
            instructions = self.query_one("#instructions", Static)
            instructions.update("Controls: [R]ecord [S]top [F]refresh [→] select [Q]uit")
            logging.info("Initial instructions set manually")
        except Exception as e:
            logging.error(f"Error setting initial instructions: {e}")
        
        # Load recordings after UI is ready
        if self.db_connected:
            await self.refresh_recordings_list()
    
    def update_recording_status(self):
        """Update recording status display"""
        status_widget = self.query_one("#recording-status", Static)
        if self.is_recording:
            status_widget.update("🔴 Recording...")
            status_widget.remove_class("status-ready")
            status_widget.add_class("status-recording")
        else:
            status_widget.update("Ready")
            status_widget.remove_class("status-recording")
            status_widget.add_class("status-ready")
    
    def update_recording_timer(self):
        """Update recording duration display"""
        duration_widget = self.query_one("#duration-display", Static)
        if self.recorder.is_recording():
            duration = self.recorder.get_recording_duration()
            minutes = int(duration // 60)
            seconds = int(duration % 60)
            duration_text = f"{minutes:02d}:{seconds:02d}"
            duration_widget.update(f"Duration: {duration_text}")
        else:
            duration_widget.update("Duration: 00:00")
    
    def action_focus_name_input(self) -> None:
        """Focus the name input field"""
        name_input = self.query_one("#recording-name", Input)
        name_input.focus()
    
    def action_open_recording(self) -> None:
        """Open the selected recording for actions"""
        asyncio.create_task(self.open_recording())
    
    def action_close_recording(self) -> None:
        """Deselect the recording"""
        logging.info("Deselecting recording")
        self.selected_recording_id = None
        logging.info(f"Selected recording ID is now: {self.selected_recording_id}")
        self.update_instructions()
    
    def action_process_recording(self) -> None:
        """Process the currently opened recording"""
        if self.selected_recording_id:
            asyncio.create_task(self.run_process_on_selected(self.selected_recording_id))
    
    def action_archive_recording(self) -> None:
        """Archive the currently opened recording"""
        if self.selected_recording_id:
            asyncio.create_task(self.archive_selected(self.selected_recording_id))
    
    def action_delete_recording(self) -> None:
        """Delete the currently opened recording"""
        if self.selected_recording_id:
            asyncio.create_task(self.delete_selected(self.selected_recording_id))
    
    async def action_start_recording(self) -> None:
        """Start recording"""
        logging.info("Start recording action triggered")
        
        if self.is_recording:
            logging.warning("Already recording, ignoring start request")
            return
        
        try:
            name_input = self.query_one("#recording-name", Input)
            name = name_input.value.strip() or None
            logging.info(f"Starting recording with name: {name}")
            
            recording_id = await self.recorder.start_recording(name)
            logging.info(f"Recording started with ID: {recording_id}")
            
            if recording_id:
                self.is_recording = True
                self.update_recording_status()
                
                # Clear name input
                name_input.value = ""
                
                # Start recording loop
                asyncio.create_task(self.recording_loop())
            else:
                logging.error("Failed to start recording - no recording ID returned")
            
        except Exception as e:
            logging.error(f"Error starting recording: {e}", exc_info=True)
            # Show error in status
            status_widget = self.query_one("#recording-status", Static)
            status_widget.update(f"ERROR: {str(e)}")
            status_widget.styles.background = "red 100%"
    
    async def action_stop_recording(self) -> None:
        """Stop recording"""
        if not self.is_recording:
            return
        
        success = await self.recorder.stop_recording()
        self.is_recording = False
        self.update_recording_status()
        
        # Refresh recordings list
        if self.db_connected:
            await self.refresh_recordings_list()
    
    async def recording_loop(self):
        """Main recording loop"""
        while self.recorder.is_recording():
            if not self.recorder.record_chunk():
                await self.action_stop_recording()
                break
            await asyncio.sleep(0.01)  # Small delay to prevent blocking
    
    async def action_refresh_list(self) -> None:
        """Refresh recordings list"""
        if self.db_connected:
            await self.refresh_recordings_list()
    
    async def refresh_recordings_list(self):
        """Refresh the recordings table"""
        if not self.db_connected:
            return
        
        recordings = await RecordingService.get_all_recordings()
        table = self.query_one("#recordings-table", DataTable)
        
        # Ensure columns are set up (in case on_ready hasn't run yet)
        if len(table.columns) == 0:
            table.add_columns("ID", "Name", "Duration", "Created", "Status")
            table.cursor_type = "row"
            table.zebra_stripes = True
        
        # Clear existing rows (but keep columns)
        table.clear(columns=False)
        
        # Add recordings
        for recording in recordings:
            duration_str = recording.duration_formatted if recording.duration else "Unknown"
            created_str = recording.created_at_formatted if recording.created_at else "Unknown"
            status = "Archived" if recording.archived else "Active"
            
            try:
                table.add_row(
                    str(recording.id),
                    recording.name,
                    duration_str,
                    created_str,
                    status
                )
            except Exception as e:
                logging.error(f"Error adding row to table: {e} - Columns: {table.columns}, Data: {[str(recording.id), recording.name, duration_str, created_str, status]}")
    
    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle row selection in recordings table"""
        # Row is now selected - user can use P, A, Delete keys
        pass
    
    def get_selected_recording_id(self) -> Optional[int]:
        """Get the ID of the currently selected recording"""
        table = self.query_one("#recordings-table", DataTable)
        if table.cursor_row is not None:
            row_key = table.coordinate_to_cell_key(table.cursor_coordinate)
            row_data = table.get_row(row_key.row_key)
            return int(row_data[0])  # ID is first column
        return None
    
    async def open_recording(self):
        """Select the current recording for actions"""
        try:
            recording_id = self.get_selected_recording_id()
            if recording_id is None:
                logging.warning("No recording selected")
                return
            
            logging.info(f"Selecting recording ID: {recording_id}")
            self.selected_recording_id = recording_id
            logging.info(f"Selected recording ID is now: {self.selected_recording_id}")
            self.update_instructions()
            
        except Exception as e:
            logging.error(f"Error selecting recording: {e}", exc_info=True)
    
    def update_instructions(self):
        """Update instructions based on current state"""
        if self.selected_recording_id:
            self.instructions_text = "Recording Selected: [P]rocess [A]rchive [Del]ete | [←/Esc] deselect | [Q]uit"
            logging.info(f"Updating instructions to: {self.instructions_text}")
        else:
            self.instructions_text = "Controls: [R]ecord [S]top [F]refresh [→] select [Q]uit"
            logging.info(f"Updating instructions to: {self.instructions_text}")
    
    def watch_instructions_text(self, old_value, new_value):
        """Update the instructions widget when text changes"""
        try:
            instructions = self.query_one("#instructions", Static)
            if instructions:
                instructions.update(new_value)
                logging.info(f"Instructions widget updated to: {new_value}")
            else:
                logging.error("Instructions widget not found")
        except Exception as e:
            logging.error(f"Error updating instructions widget: {e}", exc_info=True)
            # Try to find all Static widgets
            try:
                all_statics = self.query(Static)
                logging.info(f"Found {len(all_statics)} Static widgets")
                for i, static in enumerate(all_statics):
                    logging.info(f"Static {i}: id={static.id}, classes={static.classes}")
            except Exception as e2:
                logging.error(f"Error querying Static widgets: {e2}")
    
    async def run_process_on_selected(self, recording_id: int):
        """Run a process on the selected recording - skeleton for now"""
        # TODO: Implement process running
        pass
    
    async def archive_selected(self, recording_id: int):
        """Archive the selected recording"""
        if self.db_connected:
            await RecordingService.archive_recording(recording_id)
            self.selected_recording_id = None
            self.update_instructions()
            await self.refresh_recordings_list()
    
    async def delete_selected(self, recording_id: int):
        """Delete the selected recording"""
        if self.db_connected:
            # TODO: Add confirmation dialog
            await RecordingService.delete_recording(recording_id)
            self.selected_recording_id = None
            self.update_instructions()
            await self.refresh_recordings_list()
    
    async def on_unmount(self) -> None:
        """Cleanup when app closes"""
        if self.recorder.is_recording():
            await self.recorder.stop_recording()
        
        if self.db_connected:
            await close_database()


if __name__ == "__main__":
    app = RecordingApp()
    app.run()