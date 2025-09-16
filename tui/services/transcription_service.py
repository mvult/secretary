import logging
from typing import Dict, Any, Optional
from .deepgram_service import transcribe_from_url, transcribe_from_file
from .speaker_identification import identify_speakers_in_transcript
from db.service import RecordingService, UserService, SpeakerService


class TranscriptionService:
    """Orchestrates the full transcription and speaker identification workflow"""
    
    @staticmethod
    async def transcribe_recording(recording, source_info: Dict[str, str]) -> Dict[str, Any]:
        """
        Complete transcription workflow including speaker identification
        
        Args:
            recording: Recording model instance
            source_info: Dict with 'type' and 'path' keys indicating audio source
            
        Returns:
            Dict with success status and any error messages
        """
        try:
            # Step 1: Transcribe the audio
            if source_info["type"] == "cloud":
                transcription_result = await transcribe_from_url(source_info["path"])
            else:
                transcription_result = await transcribe_from_file(source_info["path"])
            
            if not transcription_result.get("success"):
                return {
                    "success": False,
                    "error": f"Transcription failed: {transcription_result.get('error', 'Unknown error')}"
                }
            
            transcript = transcription_result["transcript"]
            
            # Step 2: Save transcript to database
            await RecordingService.update_recording(
                recording.id, transcript=transcript
            )
            
            # Step 3: Run speaker identification if users exist
            speaker_result = await TranscriptionService._identify_speakers(
                transcript, recording.id
            )
            
            return {
                "success": True,
                "transcript": transcript,
                "speaker_mappings": speaker_result.get("mappings", []),
                "speaker_identification_success": speaker_result.get("success", False)
            }
            
        except Exception as e:
            logging.error(f"Error in transcription workflow: {e}")
            return {
                "success": False,
                "error": f"Transcription workflow failed: {e}"
            }
    
    @staticmethod
    async def _identify_speakers(transcript: str, recording_id: int) -> Dict[str, Any]:
        """Internal method to handle speaker identification"""
        try:
            # Get all users from database
            users = await UserService.get_all_users()
            if not users:
                logging.info("No users found in database, skipping speaker identification")
                return {"success": False, "error": "No users available"}
            
            # Convert users to dict format for the service
            users_dict = []
            for user in users:
                users_dict.append({
                    "id": user.id,
                    "first_name": user.first_name,
                    "last_name": user.last_name,
                    "role": user.role
                })
            
            # Run speaker identification
            result = await identify_speakers_in_transcript(
                transcript, users_dict, recording_id
            )
            
            if result.get("success") and result.get("mappings"):
                # Save mappings to database
                success = await SpeakerService.save_speaker_mappings(
                    recording_id, result["mappings"]
                )
                if success:
                    logging.info(f"Saved {len(result['mappings'])} speaker mappings for recording {recording_id}")
                    return {
                        "success": True,
                        "mappings": result["mappings"]
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to save speaker mappings to database"
                    }
            else:
                logging.warning(f"Speaker identification failed: {result.get('error', 'No mappings found')}")
                return {
                    "success": False,
                    "error": result.get("error", "No speaker mappings identified")
                }
                
        except Exception as e:
            logging.error(f"Error during speaker identification: {e}")
            return {
                "success": False,
                "error": f"Speaker identification failed: {e}"
            }