from textual.widgets import Static, Input
from textual.containers import Vertical
from textual.reactive import reactive
import asyncio
import logging
from recording.recorder import AudioRecorder


class RecorderWidget(Vertical):
    """Widget for recording controls and status"""
    
    CSS = """
    RecorderWidget {
        height: 3;
        padding: 0;
    }
    
    .recording-status {
        height: 1;
        text-align: left;
        padding: 0 1;
        background: $surface;
        border: solid $primary;
    }
    
    .status-recording {
        color: red;
    }
    
    .status-ready {
        color: green;
    }
    """
    
    is_recording = reactive(False)
    
    def watch_is_recording(self, old_value, new_value):
        """React to changes in recording state"""
        self.update_recording_status()
        if new_value:
            # Add duration display when recording starts
            self.mount(Static("⏱️ Duration: 00:00", id="duration-display"))
        else:
            # Remove duration display when recording stops
            try:
                duration_widget = self.query_one("#duration-display", Static)
                duration_widget.remove()
            except:
                pass  # Widget might not exist
    
    def __init__(self):
        super().__init__()
        self.recorder = AudioRecorder()
        
    def compose(self):
        """Create recorder UI components"""
        yield Static("🎤 RECORDER STATUS - Ready", id="recording-status", classes="recording-status status-ready")
    
    def on_mount(self):
        """Start the recording timer"""
        self.set_interval(1.0, self.update_recording_timer)
    
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
        if self.recorder.is_recording():
            try:
                duration_widget = self.query_one("#duration-display", Static)
                duration = self.recorder.get_recording_duration()
                minutes = int(duration // 60)
                seconds = int(duration % 60)
                duration_text = f"{minutes:02d}:{seconds:02d}"
                duration_widget.update(f"⏱️ Duration: {duration_text}")
            except:
                pass  # Duration widget might not exist yet
    
    async def start_recording(self):
        """Start recording"""
        logging.info("Start recording action triggered")
        
        if self.is_recording:
            logging.warning("Already recording, ignoring start request")
            return None
        
        try:
            # No name input anymore, use auto-generated name
            name = None
            logging.info("Starting recording with auto-generated name")
            
            recording_id = await self.recorder.start_recording(name)
            logging.info(f"Recording started with ID: {recording_id}")
            
            if recording_id:
                self.is_recording = True
                self.update_recording_status()
                
                # Start recording loop
                asyncio.create_task(self.recording_loop())
                return recording_id
            else:
                logging.error("Failed to start recording - no recording ID returned")
                return None
            
        except Exception as e:
            logging.error(f"Error starting recording: {e}", exc_info=True)
            # Show error in status
            status_widget = self.query_one("#recording-status", Static)
            status_widget.update(f"ERROR: {str(e)}")
            status_widget.styles.background = "red 100%"
            return None
    
    async def stop_recording(self):
        """Stop recording"""
        if not self.is_recording:
            return False
        
        success = await self.recorder.stop_recording()
        self.is_recording = False
        self.update_recording_status()
        return success
    
    async def recording_loop(self):
        """Main recording loop"""
        while self.recorder.is_recording():
            if not self.recorder.record_chunk():
                await self.stop_recording()
                break
            await asyncio.sleep(0.01)  # Small delay to prevent blocking
    
    def get_recording_status(self):
        """Get current recording status"""
        return self.is_recording