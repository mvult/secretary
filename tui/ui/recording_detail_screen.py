from textual.app import ComposeResult
from textual.containers import Container, Vertical, Horizontal, Center, Middle
from textual.widgets import Header, Static, Footer, Input, TextArea, Button
from textual.screen import Screen, ModalScreen
import logging
from db.service import RecordingService, AnalysisService, SpeakerService, TodoService, UserService
from services.storage_manager import StorageManager
from services.transcription_service import TranscriptionService
from services.analysis_service import analyze_transcript
from components.analysis_modal import AnalysisModal
from components.rename_modal import RenameModal


class RecordingDetailScreen(Screen):
    """Screen for displaying recording details"""

    inherit_bindings = False  # Don't inherit bindings from parent app

    CSS = """
    .detail-container {
        height: 100%;
        padding: 1;
    }
    
    .title-section {
        height: 4;
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
    
    .content-container {
        height: 1fr;
        margin: 1 0;
        layout: horizontal;
    }
    
    .transcript-area {
        height: 100%;
        border: solid $primary;
        margin-right: 1;
        width: 1fr;
    }
    
    .todos-container {
        width: 30;
        height: 100%;
        border: solid $primary;
        margin-left: 1;
    }
    
    .todos-title {
        height: 1;
        text-style: bold;
        color: $primary;
        padding: 0 1;
    }
    
    .todos-list {
        height: 1fr;
        padding: 0 1;
    }
    
    .todo-item {
        margin-bottom: 1;
        padding: 1;
        background: $surface;
        border: solid gray;
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
                yield Static("", id="analysis-status", classes="recording-date")

            with Container(id="content-wrapper", classes="content-container"):
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
            await self.update_display()
        # Focus the main container so it can receive key events
        main_container = self.query_one("#main-container")
        main_container.can_focus = True
        main_container.focus()

    async def update_display(self):
        """Update all display elements with recording data"""
        if not self.recording:
            return

        title_widget = self.query_one("#recording-title", Static)
        date_widget = self.query_one("#recording-date", Static)
        storage_widget = self.query_one("#storage-status", Static)
        analysis_widget = self.query_one("#analysis-status", Static)
        transcript_widget = self.query_one("#transcript", TextArea)

        title_widget.update(self.recording.name)
        date_widget.update(f"Created: {self.recording.created_at_formatted}")
        storage_widget.update(
            f"Storage: {self.recording.storage_status} (local/NAS/cloud)"
        )

        # Update analysis status - always show even if no analyses completed
        analysis_status = await AnalysisService.get_analysis_status(self.recording)
        analysis_widget.update(f"Analysis: {analysis_status}")
        logging.debug(
            f"Analysis status for recording {self.recording_id}: '{analysis_status}'"
        )

        transcript_text = self.recording.transcript or "No transcript available"
        transcript_widget.text = transcript_text
        
        # Update TODOs display
        await self.update_todos_display()

    async def update_todos_display(self):
        """Update the TODOs display based on available TODOs"""
        if not self.recording:
            return
            
        # Get TODOs for this recording
        todos = await TodoService.get_todos_by_recording(self.recording_id)
        
        # Remove existing todos container if it exists
        try:
            existing_todos = self.query_one("#todos-container")
            existing_todos.remove()
        except:
            pass
        
        if todos:
            content_wrapper = self.query_one("#content-wrapper")
            
            # Create TODO widgets
            todo_widgets = [Static("TODOs", classes="todos-title")]
            
            for todo in todos:
                # Get user name if available
                user_name = ""
                if todo.get("user_id"):
                    try:
                        users = await UserService.get_all_users()
                        user = next((u for u in users if u.id == todo["user_id"]), None)
                        if user:
                            user_name = f" (@{user.first_name})"
                    except:
                        pass
                
                todo_text = f"• {todo['name']}{user_name}"
                if todo.get('desc'):
                    todo_text += f"\n  {todo['desc']}"
                
                todo_widgets.append(Static(todo_text, classes="todo-item"))
            
            # Create and mount TODOs container with all widgets
            todos_container = Vertical(*todo_widgets, id="todos-container", classes="todos-container")
            await content_wrapper.mount(todos_container)

    def action_back(self):
        """Go back to the main screen"""
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
            result = await TranscriptionService.transcribe_recording(
                self.recording, source_info
            )

            if result["success"]:
                # Update recording object and UI
                self.recording.transcript = result["transcript"]
                transcript_widget.text = result["transcript"]

                # Show results
                if result.get("speaker_identification_success"):
                    title_widget.update(
                        f"{original_title} - Transcribed & Speakers Identified ✓"
                    )
                    logging.info(
                        f"Transcribed recording {self.recording_id} with {len(result.get('speaker_mappings', []))} speaker mappings"
                    )
                else:
                    title_widget.update(f"{original_title} - Transcribed ✓")
                    logging.info(
                        f"Transcribed recording {self.recording_id} (no speaker identification)"
                    )
            else:
                title_widget.update(f"{original_title} - Transcription failed ✗")
                logging.error(
                    f"Transcription failed: {result.get('error', 'Unknown error')}"
                )

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
        logging.info(
            f"handle_analysis_result called with analysis_type: {analysis_type}"
        )

        if not analysis_type:
            logging.info("No analysis type selected, returning")
            return

        if not self.recording:
            logging.warning("No recording available for analysis")
            return

        if not self.recording.transcript:
            logging.warning("No transcript available for analysis")
            return

        try:
            title_widget = self.query_one("#recording-title", Static)
            original_title = self.recording.name

            title_widget.update(f"{original_title} - Analyzing...")
            logging.info(
                f"Starting {analysis_type} analysis for recording {self.recording_id}"
            )

            # Get speaker mappings for TODO analysis
            speaker_mappings = []
            if analysis_type == "todos":
                speaker_mappings = await SpeakerService.get_speaker_mappings(self.recording_id)
            
            result = await analyze_transcript(
                self.recording.transcript, analysis_type, self.recording_id, speaker_mappings
            )

            logging.info(f"Analysis result: {result}")

            if result.get("success"):
                title_widget.update(f"{original_title} - Analysis complete ✓")

                if analysis_type == "todos" and result.get("todos"):
                    # TODO: Save todos to database
                    logging.info(
                        f"Extracted {len(result['todos'])} TODOs from recording {self.recording_id}"
                    )

                # Refresh the analysis status display
                await self.update_display()

                logging.info(
                    f"Analysis '{analysis_type}' completed for recording {self.recording_id}"
                )
            else:
                title_widget.update(f"{original_title} - Analysis failed ✗")
                logging.error(
                    f"Analysis failed: {result.get('content', 'Unknown error')}"
                )

        except Exception as e:
            logging.error(f"Error during analysis: {e}")
            title_widget = self.query_one("#recording-title", Static)
            title_widget.update(f"{self.recording.name} - Error ✗")

    def action_ignore(self):
        """Do nothing - used to override parent bindings"""
        pass
