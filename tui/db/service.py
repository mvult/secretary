from db.models import Recording, User, SpeakerToUser
import logging
from typing import List, Optional, Dict

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
        """Delete a recording permanently from database and all storage locations"""
        try:
            recording = await Recording.get_or_none(id=recording_id)
            if not recording:
                return False
            
            # Delete from all storage locations
            from services.storage_manager import StorageManager
            storage_manager = StorageManager()
            result = await storage_manager.delete_from_all_storage(recording)
            
            # Log any file deletion errors but still delete from database
            if result["errors"]:
                for error in result["errors"]:
                    logging.warning(f"File deletion error for recording {recording_id}: {error}")
            
            if result["deleted_locations"]:
                logging.info(f"Deleted recording {recording_id} files from: {', '.join(result['deleted_locations'])}")
            
            # Delete from database
            await recording.delete()
            return True
        except Exception as e:
            logging.error(f"Error deleting recording: {e}")
            return False


class UserService:
    """Service class for user database operations"""
    
    @staticmethod
    async def get_all_users() -> List[User]:
        """Get all users"""
        try:
            return await User.all()
        except Exception as e:
            logging.error(f"Error fetching users: {e}")
            return []
    
    @staticmethod
    async def create_user(first_name: str, last_name: str, role: str = None) -> Optional[User]:
        """Create a new user"""
        try:
            user = await User.create(
                first_name=first_name,
                last_name=last_name,
                role=role
            )
            return user
        except Exception as e:
            logging.error(f"Error creating user: {e}")
            return None


class SpeakerService:
    """Service class for speaker identification operations"""
    
    @staticmethod
    async def save_speaker_mappings(recording_id: int, mappings: List[Dict]) -> bool:
        """Save speaker to user mappings for a recording"""
        try:
            # Clear existing mappings for this recording
            await SpeakerToUser.filter(recording_id=recording_id).delete()
            
            # Create new mappings
            for mapping in mappings:
                await SpeakerToUser.create(
                    recording_id=recording_id,
                    speaker_id=mapping["speaker_id"],
                    user_id=mapping["user_id"]
                )
            
            return True
        except Exception as e:
            logging.error(f"Error saving speaker mappings: {e}")
            return False
    
    @staticmethod
    async def get_speaker_mappings(recording_id: int) -> List[SpeakerToUser]:
        """Get speaker mappings for a recording"""
        try:
            return await SpeakerToUser.filter(recording_id=recording_id).prefetch_related("user")
        except Exception as e:
            logging.error(f"Error fetching speaker mappings: {e}")
            return []