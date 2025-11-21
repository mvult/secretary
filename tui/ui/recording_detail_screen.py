import asyncio
import logging
from typing import Dict, List, Optional

from textual.app import ComposeResult
from textual.containers import Container, Vertical
from textual.reactive import reactive
from textual.screen import Screen
from textual.widgets import Footer, Header, Static, TextArea

from db.service import (
    AnalysisService,
    RecordingService,
    SpeakerService,
    TodoService,
    UserService,
)
from services.analysis_service import analyze_transcript
from services.storage_manager import StorageManager
from services.transcription_service import TranscriptionService
from components.analysis_modal import AnalysisModal
from components.rename_modal import RenameModal


class RecordingDetailScreen(Screen):
    """Screen for displaying recording details"""

    inherit_bindings = False  # Don't inherit bindings from parent app

    active_view = reactive("transcript")

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
    }

    .analysis-wrapper {
        height: 1fr;
        layout: vertical;
        width: 1fr;
    }

    .view-label {
        height: 1;
        padding: 0 1;
        text-style: bold;
        color: $primary;
    }

    .analysis-text {
        height: 1fr;
        border: solid $primary;
        width: 1fr;
    }

    """

    VIEW_LABELS = {
        "transcript": "Transcript",
        "summary": "Summary",
        "todos": "TODOs",
    }

    BINDINGS = [
        ("escape,q,left", "back", "Back to List"),
        ("ctrl+t", "transcribe", "Generate transcription for recording"),
        ("ctrl+a", "analyze", "Analyze transcript"),
        ("ctrl+d", "delete_recording", "Delete recording"),
        ("a", "archive_recording", "Archive recording"),
        ("c", "toggle_cloud", "Toggle Cloud Storage"),
        ("n", "toggle_nas", "Toggle NAS Storage"),
        ("l", "toggle_local", "Toggle Local Storage"),
        ("down", "view_next", "Next output view"),
        ("up", "view_prev", "Previous output view"),
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
        self._transcription_task: Optional[asyncio.Task] = None
        self._analysis_task: Optional[asyncio.Task] = None
        self._storage_tasks: Dict[str, asyncio.Task] = {}
        self._available_views: List[str] = ["transcript"]
        self._transcript_text = "No transcript available."
        self._summary_text = "No summary available."
        self._todos_text = "No TODOs available."

    async def on_mount(self):
        """Load recording data when screen mounts"""
        try:
            self.recording = await RecordingService.get_recording_by_id(
                self.recording_id
            )
        except Exception as e:
            logging.error(f"Error loading recording {self.recording_id}: {e}")

        analysis_text = self.query_one("#analysis-text", TextArea)
        analysis_text.can_focus = False

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
                with Container(classes="analysis-wrapper"):
                    yield Static("Transcript", id="view-label", classes="view-label")
                    yield TextArea(
                        "No transcript available.",
                        id="analysis-text",
                        classes="analysis-text",
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
        text_widget = self.query_one("#analysis-text", TextArea)

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

        self._transcript_text = self.recording.transcript or "No transcript available."
        summary_present = bool(self.recording.summary)
        self._summary_text = self.recording.summary or "No summary available."

        todos_text, todos_available = await self._build_todos_text()
        self._todos_text = todos_text

        available_views: List[str] = ["transcript"]
        if summary_present:
            available_views.append("summary")
        if todos_available:
            available_views.append("todos")

        self._set_available_views(available_views)

        label_widget = self.query_one("#view-label", Static)

        if not self.is_mounted:
            if self.active_view == "summary" and summary_present:
                text_widget.text = self._summary_text
                label_widget.update(self.VIEW_LABELS["summary"])
            elif self.active_view == "todos" and todos_available:
                text_widget.text = self._todos_text
                label_widget.update(self.VIEW_LABELS["todos"])
            else:
                text_widget.text = self._transcript_text
                label_widget.update(self.VIEW_LABELS["transcript"])

    def watch_active_view(self, old_view: str, new_view: str) -> None:
        if not self.is_mounted:
            return
        self._refresh_active_view()

    def _set_available_views(self, views: List[str]) -> None:
        if not views:
            views = ["transcript"]
        self._available_views = views
        if self.active_view not in views:
            self.active_view = views[0]
        elif self.is_mounted:
            self._refresh_active_view()

    def _cycle_view(self, step: int) -> None:
        if not self._available_views:
            return
        try:
            index = self._available_views.index(self.active_view)
        except ValueError:
            self.active_view = self._available_views[0]
            return
        new_index = (index + step) % len(self._available_views)
        if new_index != index:
            self.active_view = self._available_views[new_index]

    def _refresh_active_view(self) -> None:
        if not self._available_views:
            text_widget = self.query_one("#analysis-text", TextArea)
            label_widget = self.query_one("#view-label", Static)
            text_widget.text = self._transcript_text
            label_widget.update(self.VIEW_LABELS["transcript"])
            return

        if self.active_view not in self._available_views and self._available_views:
            self.active_view = self._available_views[0]
            return

        text_widget = self.query_one("#analysis-text", TextArea)
        label_widget = self.query_one("#view-label", Static)
        if self.active_view == "summary":
            text_widget.text = self._summary_text
            label_widget.update(self.VIEW_LABELS["summary"])
        elif self.active_view == "todos":
            text_widget.text = self._todos_text
            label_widget.update(self.VIEW_LABELS["todos"])
        else:
            text_widget.text = self._transcript_text
            label_widget.update(self.VIEW_LABELS["transcript"])

    async def _build_todos_text(self) -> tuple[str, bool]:
        if not self.recording:
            return "No TODOs available.", False

        todos = await TodoService.get_todos_by_recording(self.recording_id)
        if not todos:
            return "No TODOs available.", False

        users = await UserService.get_all_users()
        user_map = {user.id: user for user in users}

        lines: List[str] = []
        for todo in todos:
            user_note = ""
            user_id = todo.get("user_id")
            if user_id is not None:
                user = user_map.get(user_id)
                if user:
                    user_note = f" (@{user.first_name})"

            lines.append(f"• {todo['name']}{user_note}")
            if todo.get("desc"):
                lines.append(f"  {todo['desc']}")
            lines.append("")

        if lines and lines[-1] == "":
            lines.pop()

        return "\n".join(lines), True

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

        if self._transcription_task and not self._transcription_task.done():
            logging.info("Transcription already in progress for %s", self.recording_id)
            return

        title_widget = self.query_one("#recording-title", Static)
        text_widget = self.query_one("#analysis-text", TextArea)
        original_title = self.recording.name
        title_widget.update(f"{original_title} - Transcribing...")

        try:
            source_info = await self.storage_manager.get_first_available_source(
                self.recording
            )
        except Exception as exc:
            logging.error("Error locating audio source: %s", exc)
            title_widget.update(f"{original_title} - Error ✗")
            return

        if not source_info:
            title_widget.update(f"{original_title} - No audio source available ✗")
            return

        task = asyncio.create_task(
            self._run_transcription(source_info, text_widget)
        )
        self._transcription_task = task
        task.add_done_callback(
            lambda t, title=original_title: self._on_transcription_done(t, title)
        )

    async def _run_transcription(self, source_info, text_widget: TextArea) -> Dict[str, object]:
        result = await TranscriptionService.transcribe_recording(
            self.recording, source_info
        )
        if result.get("success"):
            transcript_text = result.get("transcript", "")
            updated = await RecordingService.get_recording_by_id(self.recording_id)
            if updated:
                self.recording = updated
            else:
                self.recording.transcript = transcript_text
            display_text = transcript_text or "No transcript available."
            self._transcript_text = display_text
            if self.active_view == "transcript":
                text_widget.text = display_text
        return result

    def _on_transcription_done(
        self, task: asyncio.Task, original_title: str
    ) -> None:
        self._transcription_task = None

        if not self.is_mounted:
            return

        title_widget = self.query_one("#recording-title", Static)

        try:
            result = task.result()
        except Exception as exc:
            logging.error("Error transcribing recording %s: %s", self.recording_id, exc)
            title_widget.update(f"{original_title} - Error ✗")
            return

        if result.get("success"):
            if result.get("speaker_identification_success"):
                title_widget.update(
                    f"{original_title} - Transcribed & Speakers Identified ✓"
                )
                logging.info(
                    "Transcribed recording %s with %d speaker mappings",
                    self.recording_id,
                    len(result.get("speaker_mappings", [])),
                )
            else:
                title_widget.update(f"{original_title} - Transcribed ✓")
                logging.info(
                    "Transcribed recording %s (no speaker identification)",
                    self.recording_id,
                )
            asyncio.create_task(self.update_display())
        else:
            title_widget.update(f"{original_title} - Transcription failed ✗")
            logging.error(
                "Transcription failed: %s", result.get("error", "Unknown error")
            )

    async def action_toggle_cloud(self):
        """Toggle cloud storage for recording"""
        if not self.recording:
            return

        if self._storage_tasks.get("cloud") and not self._storage_tasks["cloud"].done():
            logging.info("Cloud toggle already in progress for %s", self.recording_id)
            return

        title_widget = self.query_one("#recording-title", Static)
        original_title = self.recording.name
        title_widget.update(f"{original_title} - Processing...")

        task = asyncio.create_task(self._toggle_cloud_backend())
        self._storage_tasks["cloud"] = task
        task.add_done_callback(
            lambda t, title=original_title, key="cloud": self._on_storage_toggle_done(
                key, t, title
            )
        )

    async def action_toggle_nas(self):
        """Toggle NAS storage for recording"""
        if not self.recording:
            return

        if self._storage_tasks.get("nas") and not self._storage_tasks["nas"].done():
            logging.info("NAS toggle already in progress for %s", self.recording_id)
            return

        title_widget = self.query_one("#recording-title", Static)
        original_title = self.recording.name
        title_widget.update(f"{original_title} - Processing...")

        task = asyncio.create_task(self._toggle_nas_backend())
        self._storage_tasks["nas"] = task
        task.add_done_callback(
            lambda t, title=original_title, key="nas": self._on_storage_toggle_done(
                key, t, title
            )
        )

    async def action_toggle_local(self):
        """Toggle local storage for recording"""
        if not self.recording:
            return

        if self._storage_tasks.get("local") and not self._storage_tasks["local"].done():
            logging.info("Local toggle already in progress for %s", self.recording_id)
            return

        title_widget = self.query_one("#recording-title", Static)
        original_title = self.recording.name
        title_widget.update(f"{original_title} - Processing...")

        task = asyncio.create_task(self._toggle_local_backend())
        self._storage_tasks["local"] = task
        task.add_done_callback(
            lambda t, title=original_title, key="local": self._on_storage_toggle_done(
                key, t, title
            )
        )

    async def _toggle_cloud_backend(self) -> Dict[str, object]:
        result = await self.storage_manager.toggle_cloud_storage(self.recording)
        if result.get("success"):
            updated = await RecordingService.get_recording_by_id(self.recording_id)
            if updated:
                self.recording = updated
        return result

    async def _toggle_nas_backend(self) -> Dict[str, object]:
        result = await self.storage_manager.toggle_nas_storage(self.recording)
        if result.get("success"):
            updated = await RecordingService.get_recording_by_id(self.recording_id)
            if updated:
                self.recording = updated
        return result

    async def _toggle_local_backend(self) -> Dict[str, object]:
        result = await self.storage_manager.toggle_local_storage(self.recording)
        if result.get("success"):
            updated = await RecordingService.get_recording_by_id(self.recording_id)
            if updated:
                self.recording = updated
        return result

    def _on_storage_toggle_done(
        self, key: str, task: asyncio.Task, original_title: str
    ) -> None:
        stored_task = self._storage_tasks.get(key)
        if stored_task is task:
            self._storage_tasks.pop(key, None)

        if not self.is_mounted:
            return

        title_widget = self.query_one("#recording-title", Static)
        storage_widget = self.query_one("#storage-status", Static)

        try:
            result = task.result()
        except Exception as exc:
            logging.error("Error toggling %s storage: %s", key, exc)
            title_widget.update(f"{original_title} - Error ✗")
            return

        if result.get("success"):
            action = result.get("action", "updated").title()
            title_widget.update(f"{original_title} - {action} ✓")
            if self.recording:
                storage_widget.update(
                    f"Storage: {self.recording.storage_status} (local/NAS/cloud)"
                )
            logging.info(
                "%s storage %s for recording %s",
                key.upper(),
                result.get("action", "updated"),
                self.recording_id,
            )
        else:
            title_widget.update(f"{original_title} - Error ✗")
            logging.error(
                "Failed to toggle %s storage: %s",
                key,
                result.get("error", "Unknown error"),
            )

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

        if self._analysis_task and not self._analysis_task.done():
            logging.info("Analysis already running for %s", self.recording_id)
            return

        title_widget = self.query_one("#recording-title", Static)
        original_title = self.recording.name
        title_widget.update(f"{original_title} - Analyzing...")
        logging.info(
            "Starting %s analysis for recording %s", analysis_type, self.recording_id
        )

        task = asyncio.create_task(
            self._run_analysis(analysis_type)
        )
        self._analysis_task = task
        task.add_done_callback(
            lambda t, title=original_title, a_type=analysis_type: self._on_analysis_done(
                t, title, a_type
            )
        )

    async def _run_analysis(self, analysis_type: str) -> Dict[str, object]:
        speaker_mappings = []
        if analysis_type == "todos":
            speaker_mappings = await SpeakerService.get_speaker_mappings(self.recording_id)

        result = await analyze_transcript(
            self.recording.transcript,
            analysis_type,
            self.recording_id,
            speaker_mappings,
        )

        if result.get("success"):
            updated = await RecordingService.get_recording_by_id(self.recording_id)
            if updated:
                self.recording = updated

        return result

    def _on_analysis_done(
        self, task: asyncio.Task, original_title: str, analysis_type: str
    ) -> None:
        self._analysis_task = None

        if not self.is_mounted:
            return

        title_widget = self.query_one("#recording-title", Static)

        try:
            result = task.result()
        except Exception as exc:
            logging.error("Error during analysis: %s", exc)
            title_widget.update(f"{original_title} - Error ✗")
            return

        if result.get("success"):
            title_widget.update(f"{original_title} - Analysis complete ✓")
            if analysis_type == "todos" and result.get("todos"):
                logging.info(
                    "Extracted %d TODOs from recording %s",
                    len(result.get("todos", [])),
                    self.recording_id,
                )

            asyncio.create_task(self.update_display())
            logging.info(
                "Analysis '%s' completed for recording %s",
                analysis_type,
                self.recording_id,
            )
        else:
            title_widget.update(f"{original_title} - Analysis failed ✗")
            logging.error(
                "Analysis failed: %s",
                result.get("content", result.get("error", "Unknown error")),
            )

    def action_ignore(self):
        """Do nothing - used to override parent bindings"""
        pass

    def action_view_next(self) -> None:
        self._cycle_view(1)

    def action_view_prev(self) -> None:
        self._cycle_view(-1)
