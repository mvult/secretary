from textual.app import ComposeResult
from textual.containers import Container, Vertical, Horizontal, Center, Middle
from textual.widgets import Header, Static, Footer, Input, TextArea, Button
from textual.screen import Screen, ModalScreen
import logging
from db.service import RecordingService
from services.storage_manager import StorageManager
from services.transcription_service import TranscriptionService
from services.analysis_service import analyze_transcript
from components.analysis_modal import AnalysisModal


class RenameModal(ModalScreen):
    """Modal for renaming a recording"""

    CSS = """
    RenameModal {
        align: center middle;
    }
    
    .rename-dialog {
        width: 60;
        height: 9;
        background: $surface;
        border: solid $primary;
        padding: 2;
    }
    
    #rename-input {
        width: 100%;
        height: 13;
        margin: 1 0;
        padding: 1;
        border: solid $primary;
    }
    """

    def __init__(self, current_name: str):
        super().__init__()
        self.current_name = current_name
        self.new_name = None

    def compose(self) -> ComposeResult:
        with Container(classes="rename-dialog"):
            yield Static("Rename Recording:", classes="dialog-title")
            yield Input(value=self.current_name, id="rename-input")
            with Horizontal():
                yield Button("Save", variant="primary", id="save-btn")
                yield Button("Cancel", variant="default", id="cancel-btn")

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "save-btn":
            input_widget = self.query_one("#rename-input", Input)
            self.new_name = input_widget.value.strip()
            self.dismiss(self.new_name)
        else:
            self.dismiss(None)

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "rename-input":
            self.new_name = event.input.value.strip()
            self.dismiss(self.new_name)


class RecordingDetailScreen(Screen):
    """Screen for displaying recording details"""

    inherit_bindings = False  # Don't inherit bindings from parent app

    CSS = """
    .detail-container {
        height: 100%;
        padding: 1;
    }
    
    .title-section {
        height: 3;
        margin-bottom: 1;
    }
    
    .recording-title {
        text-style: bold;
        color: $primary;
        height: 1;
    }
    
    .recording-date {
        color: $text-muted;
        height: 1;
    }
    
    .transcript-container {
        height: 1fr;
        border: solid $primary;
        margin: 1 0;
    }
    
    .transcript-area {
        height: 100%;
    }
    
    """

    BINDINGS = [
        ("escape,q,left", "back", "Back to List"),
        ("ctrl+t", "transcribe", "Generate transcription for recording"),
        ("ctrl+a", "analyze", "Analyze transcript"),
        ("ctrl+d", "delete_recording", "Delete recording"),
        ("a", "archive_recording", "Archive recording"),
        ("c", "toggle_cloud", "Toggle Cloud Storage"),
        ("n", "toggle_nas", "Toggle NAS Storage"),
        ("l", "toggle_local", "Toggle Local Storage"),
        # Override main app bindings to disable them
        ("r", "rename", "Rename the recording"),
        ("s", "ignore", ""),
        ("f", "ignore", ""),
    ]

    def __init__(self, recording_id: int):
        super().__init__()
        self.recording_id = recording_id
        self.recording = None
        self.storage_manager = StorageManager()

    async def on_mount(self):
        """Load recording data when screen mounts"""
        try:
            self.recording = await RecordingService.get_recording_by_id(
                self.recording_id
            )
        except Exception as e:
            logging.error(f"Error loading recording {self.recording_id}: {e}")

    def compose(self) -> ComposeResult:
        """Create the UI layout"""
        yield Header(show_clock=False)

        with Vertical(classes="detail-container", id="main-container"):
            # Title and date section
            with Container(classes="title-section"):
                yield Static(
                    "Loading...", id="recording-title", classes="recording-title"
                )
                yield Static("", id="recording-date", classes="recording-date")
                yield Static("", id="storage-status", classes="recording-date")

            with Container(classes="transcript-container"):
                yield TextArea(
                    "No transcript available",
                    id="transcript",
                    classes="transcript-area",
                    read_only=True,
                )

        yield Footer()

    async def on_screen_resume(self):
        """Update display when screen becomes active"""
        if self.recording:
            self.update_display()
        # Focus the main container so it can receive key events
        main_container = self.query_one("#main-container")
        main_container.can_focus = True
        main_container.focus()

    def update_display(self):
        """Update all display elements with recording data"""
        if not self.recording:
            return

        title_widget = self.query_one("#recording-title", Static)
        date_widget = self.query_one("#recording-date", Static)
        storage_widget = self.query_one("#storage-status", Static)
        transcript_widget = self.query_one("#transcript", TextArea)

        title_widget.update(self.recording.name)
        date_widget.update(f"Created: {self.recording.created_at_formatted}")
        storage_widget.update(
            f"Storage: {self.recording.storage_status} (local/NAS/cloud)"
        )

        transcript_text = self.recording.transcript or "No transcript available"
        transcript_widget.text = transcript_text

    def action_back(self):
        """Go back to the main screen"""
        logging.info("Going back")
        self.app.pop_screen()

    async def action_delete_recording(self):
        """Delete the recording"""
        if self.recording:
            try:
                await RecordingService.delete_recording(self.recording_id)
                logging.info(f"Deleted recording {self.recording_id}")
                self.app.pop_screen()
            except Exception as e:
                logging.error(f"Error deleting recording {self.recording_id}: {e}")

    async def action_archive_recording(self):
        """Archive the recording"""
        if self.recording:
            try:
                await RecordingService.archive_recording(self.recording_id)
                logging.info(f"Archived recording {self.recording_id}")
                # Update the recording object to reflect the change
                self.recording.archived = True
            except Exception as e:
                logging.error(f"Error archiving recording {self.recording_id}: {e}")

    def action_rename(self):
        """Start renaming the recording"""
        if self.recording:
            current_name = self.recording.name
            modal = RenameModal(current_name)
            self.app.push_screen(modal, callback=self.handle_rename_result)

    async def handle_rename_result(self, new_name):
        """Handle the result from the rename modal"""
        if new_name and self.recording and new_name != self.recording.name:
            try:
                # Update the recording name
                await RecordingService.update_recording(
                    self.recording_id, name=new_name
                )
                self.recording.name = new_name
                self.update_display()
                logging.info(f"Renamed recording {self.recording_id} to '{new_name}'")
            except Exception as e:
                logging.error(f"Error renaming recording {self.recording_id}: {e}")

    async def action_transcribe(self):
        """Generate transcription using Deepgram"""
        if not self.recording:
            return

        try:
            title_widget = self.query_one("#recording-title", Static)
            transcript_widget = self.query_one("#transcript", TextArea)
            original_title = self.recording.name

            title_widget.update(f"{original_title} - Transcribing...")

            # Try to get first available source
            source_info = await self.storage_manager.get_first_available_source(
                self.recording
            )
            if not source_info:
                title_widget.update(f"{original_title} - No audio source available ✗")
                return

            # Run full transcription workflow (includes speaker identification)
            result = await TranscriptionService.transcribe_recording(self.recording, source_info)

            if result["success"]:
                # Update recording object and UI
                self.recording.transcript = result["transcript"]
                transcript_widget.text = result["transcript"]
                
                # Show results
                if result.get("speaker_identification_success"):
                    title_widget.update(f"{original_title} - Transcribed & Speakers Identified ✓")
                    logging.info(f"Transcribed recording {self.recording_id} with {len(result.get('speaker_mappings', []))} speaker mappings")
                else:
                    title_widget.update(f"{original_title} - Transcribed ✓")
                    logging.info(f"Transcribed recording {self.recording_id} (no speaker identification)")
            else:
                title_widget.update(f"{original_title} - Transcription failed ✗")
                logging.error(f"Transcription failed: {result.get('error', 'Unknown error')}")

        except Exception as e:
            logging.error(f"Error transcribing recording: {e}")
            title_widget = self.query_one("#recording-title", Static)
            title_widget.update(f"{self.recording.name} - Error ✗")

    async def action_toggle_cloud(self):
        """Toggle cloud storage for recording"""
        if not self.recording:
            return

        try:
            title_widget = self.query_one("#recording-title", Static)
            storage_widget = self.query_one("#storage-status", Static)
            original_title = self.recording.name

            title_widget.update(f"{original_title} - Processing...")

            result = await self.storage_manager.toggle_cloud_storage(self.recording)

            if result["success"]:
                # Reload recording to get updated data
                self.recording = await RecordingService.get_recording_by_id(
                    self.recording_id
                )
                title_widget.update(f"{original_title} - {result['action'].title()} ✓")
                storage_widget.update(
                    f"Storage: {self.recording.storage_status} (local/NAS/cloud)"
                )
                logging.info(
                    f"Cloud storage {result['action']} for recording {self.recording_id}"
                )
            else:
                title_widget.update(f"{original_title} - Error ✗")
                logging.error(
                    f"Failed to toggle cloud storage: {result.get('error', 'Unknown error')}"
                )

        except Exception as e:
            logging.error(f"Error toggling cloud storage: {e}")
            title_widget = self.query_one("#recording-title", Static)
            title_widget.update(f"{self.recording.name} - Error ✗")

    async def action_toggle_nas(self):
        """Toggle NAS storage for recording"""
        if not self.recording:
            return

        try:
            title_widget = self.query_one("#recording-title", Static)
            storage_widget = self.query_one("#storage-status", Static)
            original_title = self.recording.name

            title_widget.update(f"{original_title} - Processing...")

            result = await self.storage_manager.toggle_nas_storage(self.recording)

            if result["success"]:
                # Reload recording to get updated data
                self.recording = await RecordingService.get_recording_by_id(
                    self.recording_id
                )
                title_widget.update(f"{original_title} - {result['action'].title()} ✓")
                storage_widget.update(
                    f"Storage: {self.recording.storage_status} (local/NAS/cloud)"
                )
                logging.info(
                    f"NAS storage {result['action']} for recording {self.recording_id}"
                )
            else:
                title_widget.update(f"{original_title} - Error ✗")
                logging.error(
                    f"Failed to toggle NAS storage: {result.get('error', 'Unknown error')}"
                )

        except Exception as e:
            logging.error(f"Error toggling NAS storage: {e}")
            title_widget = self.query_one("#recording-title", Static)
            title_widget.update(f"{self.recording.name} - Error ✗")

    async def action_toggle_local(self):
        """Toggle local storage for recording"""
        if not self.recording:
            return

        try:
            title_widget = self.query_one("#recording-title", Static)
            storage_widget = self.query_one("#storage-status", Static)
            original_title = self.recording.name

            title_widget.update(f"{original_title} - Processing...")

            result = await self.storage_manager.toggle_local_storage(self.recording)

            if result["success"]:
                # Reload recording to get updated data
                self.recording = await RecordingService.get_recording_by_id(
                    self.recording_id
                )
                title_widget.update(f"{original_title} - {result['action'].title()} ✓")
                storage_widget.update(
                    f"Storage: {self.recording.storage_status} (local/NAS/cloud)"
                )
                logging.info(
                    f"Local storage {result['action']} for recording {self.recording_id}"
                )
            else:
                title_widget.update(f"{original_title} - Error ✗")
                logging.error(
                    f"Failed to toggle local storage: {result.get('error', 'Unknown error')}"
                )

        except Exception as e:
            logging.error(f"Error toggling local storage: {e}")
            title_widget = self.query_one("#recording-title", Static)
            title_widget.update(f"{self.recording.name} - Error ✗")

    def action_analyze(self):
        """Show analysis menu for transcript"""
        logging.info("action_analyze called")
        if not self.recording:
            logging.warning("No recording available")
            return
        if not self.recording.transcript:
            logging.warning("No transcript available for analysis")
            return
        
        logging.info("Opening analysis modal")
        modal = AnalysisModal(self.recording.transcript)
        self.app.push_screen(modal, callback=self.handle_analysis_result)

    async def handle_analysis_result(self, analysis_type):
        """Handle the result from the analysis modal"""
        if not analysis_type or not self.recording or not self.recording.transcript:
            return
        
        try:
            title_widget = self.query_one("#recording-title", Static)
            original_title = self.recording.name
            
            title_widget.update(f"{original_title} - Analyzing...")
            
            result = await analyze_transcript(
                self.recording.transcript, 
                analysis_type, 
                self.recording_id
            )
            
            if result.get("success"):
                title_widget.update(f"{original_title} - Analysis complete ✓")
                
                if analysis_type == "todos" and result.get("todos"):
                    # TODO: Save todos to database
                    logging.info(f"Extracted {len(result['todos'])} TODOs from recording {self.recording_id}")
                    
                logging.info(f"Analysis '{analysis_type}' completed for recording {self.recording_id}")
                # TODO: Show analysis results in a modal or update UI
            else:
                title_widget.update(f"{original_title} - Analysis failed ✗")
                logging.error(f"Analysis failed: {result.get('content', 'Unknown error')}")
                
        except Exception as e:
            logging.error(f"Error during analysis: {e}")
            title_widget = self.query_one("#recording-title", Static)
            title_widget.update(f"{self.recording.name} - Error ✗")

    def action_ignore(self):
        """Do nothing - used to override parent bindings"""
        pass
