from db.models import Recording, User, SpeakerToUser, Todo
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
        """Get all recordings ordered by creation time with analysis metadata"""
        try:
            where_clause = "" if include_archived else "WHERE r.archived = FALSE"
            query = f"""
                SELECT r.*,
                       COALESCE(s.has_speakers, FALSE) AS has_speakers,
                       COALESCE(t.has_todos, FALSE) AS has_todos
                FROM recording r
                LEFT JOIN (
                    SELECT recording_id, TRUE AS has_speakers
                    FROM speaker_to_user
                    GROUP BY recording_id
                ) s ON s.recording_id = r.id
                LEFT JOIN (
                    SELECT created_at_recording_id AS recording_id, TRUE AS has_todos
                    FROM todo
                    GROUP BY created_at_recording_id
                ) t ON t.recording_id = r.id
                {where_clause}
                ORDER BY r.created_at DESC
            """

            recordings = await Recording.raw(query)

            for recording in recordings:
                has_speakers = bool(getattr(recording, "has_speakers", False))
                has_todos = bool(getattr(recording, "has_todos", False))
                has_summary = bool(recording.summary)
                status_parts = [
                    f"{'✓' if has_speakers else '✗'} speakers",
                    f"{'✓' if has_todos else '✗'} todos",
                    f"{'✓' if has_summary else '✗'} summary",
                ]
                setattr(recording, "analysis_status", " | ".join(status_parts))

            return recordings
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
            from tortoise import connections
            db = connections.get("default")
            
            # Clear existing mappings for this recording
            await db.execute_query(
                "DELETE FROM speaker_to_user WHERE recording_id = $1",
                [recording_id]
            )
            
            # Create new mappings
            for mapping in mappings:
                # Ensure all values are integers
                # Convert "Speaker 0" to just 0 (integer)
                speaker_id = mapping["speaker_id"]
                if speaker_id.startswith("Speaker "):
                    speaker_id = int(speaker_id.replace("Speaker ", ""))
                else:
                    speaker_id = int(speaker_id)
                
                user_id = int(mapping["user_id"])
                recording_id_int = int(recording_id)
                
                await db.execute_query(
                    "INSERT INTO speaker_to_user (recording_id, speaker_id, user_id) VALUES ($1, $2, $3)",
                    [recording_id_int, speaker_id, user_id]
                )
            
            return True
        except Exception as e:
            logging.error(f"Error saving speaker mappings: {e}")
            return False
    
    @staticmethod
    async def get_speaker_mappings(recording_id: int) -> List[Dict]:
        """Get speaker mappings for a recording"""
        try:
            from tortoise import connections
            db = connections.get("default")
            result = await db.execute_query_dict(
                "SELECT recording_id, speaker_id, user_id FROM speaker_to_user WHERE recording_id = $1",
                [recording_id]
            )
            return result
        except Exception as e:
            logging.error(f"Error fetching speaker mappings: {e}")
            return []


class AnalysisService:
    """Service class for analysis status operations"""
    
    @staticmethod
    async def get_analysis_status(recording) -> str:
        """Get analysis status indicators for a recording"""
        try:
            # Check speaker identification
            speaker_mappings = await SpeakerService.get_speaker_mappings(recording.id)
            has_speakers = len(speaker_mappings) > 0
            
            # Check summary (column in recording table)
            has_summary = bool(recording.summary)
            
            # Check TODOs (separate table with created_at_recording_id)
            has_todos = False
            try:
                from db.models import Todo
                todos = await Todo.filter(created_at_recording_id=recording.id)
                has_todos = len(todos) > 0
            except Exception as e:
                logging.error(f"Error checking TODOs: {e}")
            
            # Build status string
            status_parts = [
                f"{'✓' if has_speakers else '✗'} speakers",
                f"{'✓' if has_todos else '✗'} todos",
                f"{'✓' if has_summary else '✗'} summary",
            ]
            
            return " | ".join(status_parts)
            
        except Exception as e:
            logging.error(f"Error getting analysis status: {e}")
            return "✗ speakers | ✗ todos | ✗ summary"


class TodoService:
    """Service class for TODO operations"""
    
    @staticmethod
    async def create_todo(name: str, desc: str = None, status: str = "pending", 
                         user_id: int = None, created_at_recording_id: int = None,
                         updated_at_recording_id: int = None) -> bool:
        """Create a new TODO"""
        try:
            from db.models import Todo
            await Todo.create(
                name=name,
                desc=desc,
                status=status,
                user_id=user_id,
                created_at_recording_id=created_at_recording_id,
                updated_at_recording_id=updated_at_recording_id
            )
            return True
        except Exception as e:
            logging.error(f"Error creating TODO: {e}")
            return False
    
    @staticmethod
    async def get_todos_by_recording(recording_id: int) -> List[Dict]:
        """Get all TODOs for a recording"""
        try:
            from db.models import Todo
            todos = await Todo.filter(created_at_recording_id=recording_id)
            return [
                {
                    "id": todo.id,
                    "name": todo.name,
                    "desc": todo.desc,
                    "status": todo.status,
                    "user_id": todo.user_id
                }
                for todo in todos
            ]
        except Exception as e:
            logging.error(f"Error fetching TODOs: {e}")
            return []
