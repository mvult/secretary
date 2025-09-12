from db.models import Recording
import logging
from typing import List, Optional

class RecordingService:
    """Service class for recording database operations"""
    
    @staticmethod
    async def create_recording(name: str, local_audio_path: str = None, 
                             duration: int = None, notes: str = None) -> Optional[Recording]:
        """Create a new recording entry"""
        try:
            recording = await Recording.create(
                name=name,
                local_audio=local_audio_path,
                duration=duration,
                notes=notes
            )
            return recording
        except Exception as e:
            logging.error(f"Error creating recording: {e}")
            return None
    
    @staticmethod
    async def get_all_recordings(include_archived: bool = False) -> List[Recording]:
        """Get all recordings ordered by creation time (newest first)"""
        try:
            if include_archived:
                return await Recording.all()
            else:
                return await Recording.filter(archived=False)
        except Exception as e:
            logging.error(f"Error fetching recordings: {e}")
            return []
    
    @staticmethod
    async def get_recording_by_id(recording_id: int) -> Optional[Recording]:
        """Get a specific recording by ID"""
        try:
            return await Recording.get_or_none(id=recording_id)
        except Exception as e:
            logging.error(f"Error fetching recording: {e}")
            return None
    
    @staticmethod
    async def update_recording(recording_id: int, **kwargs) -> bool:
        """Update recording fields"""
        try:
            recording = await Recording.get_or_none(id=recording_id)
            if not recording:
                return False
            
            for key, value in kwargs.items():
                if hasattr(recording, key):
                    setattr(recording, key, value)
            
            await recording.save()
            return True
        except Exception as e:
            logging.error(f"Error updating recording: {e}")
            return False
    
    @staticmethod
    async def archive_recording(recording_id: int) -> bool:
        """Archive a recording (set archived=True)"""
        return await RecordingService.update_recording(recording_id, archived=True)
    
    @staticmethod
    async def unarchive_recording(recording_id: int) -> bool:
        """Unarchive a recording (set archived=False)"""
        return await RecordingService.update_recording(recording_id, archived=False)
    
    @staticmethod
    async def delete_recording(recording_id: int) -> bool:
        """Delete a recording permanently"""
        try:
            recording = await Recording.get_or_none(id=recording_id)
            if not recording:
                return False
            
            await recording.delete()
            return True
        except Exception as e:
            logging.error(f"Error deleting recording: {e}")
            return False