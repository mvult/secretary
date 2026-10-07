import asyncio
import os
import shutil
from typing import Any, Dict, Optional

import requests

from services.backend_storage import BackendStorage
from services.audio_files import storage_name
from db.service import RecordingService
import logging


class StorageManager:
    def __init__(self):
        self.nas_dir = "/Volumes/s3/sec-recordings"
        self.cloud = BackendStorage()

    def _download_from_cloud_sync(self, url: str, dest_path: str) -> bool:
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        temporary = dest_path + ".part"
        try:
            with requests.get(url, stream=True, timeout=(30, 120)) as response:
                response.raise_for_status()
                with open(temporary, "wb") as f:
                    for chunk in response.iter_content(chunk_size=65536):
                        f.write(chunk)
            os.replace(temporary, dest_path)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
        return True

    def _copy_file_sync(self, source: str, dest: str) -> bool:
        shutil.copy2(source, dest)
        return True

    def _remove_file_sync(self, path: str) -> None:
        os.remove(path)
    
    async def download_from_cloud(self, url: str, dest_path: str) -> bool:
        """Download file from cloud URL to local path"""
        try:
            return await asyncio.to_thread(
                self._download_from_cloud_sync, url, dest_path
            )
        except Exception as e:
            logging.error(f"Failed to download from {url}: {e}")
            return False
    
    async def get_first_available_source(self, recording) -> Optional[Dict[str, str]]:
        """Return info about first available file source"""
        # Check local first
        if recording.local_audio and os.path.exists(recording.local_audio):
            return {"type": "local", "path": recording.local_audio}
        
        # Check NAS second
        if recording.nas_audio and os.path.exists(recording.nas_audio):
            return {"type": "nas", "path": recording.nas_audio}
        
        # Check cloud third
        if getattr(recording, "audio_object_key", None) or recording.audio_url:
            return {"type": "cloud", "path": await self.cloud.download_url(recording.id)}
        
        return None
    
    def count_storage_locations(self, recording) -> int:
        """Count how many storage locations have the recording"""
        count = 0
        
        # Check local
        if recording.local_audio and os.path.exists(recording.local_audio):
            count += 1
            
        # Check NAS
        if recording.nas_audio and os.path.exists(recording.nas_audio):
            count += 1
            
        # Check cloud
        if getattr(recording, "audio_object_key", None) or recording.audio_url:
            count += 1
            
        return count
    
    async def copy_from_source(self, source_info: Dict[str, str], dest_path: str) -> bool:
        """Copy file from source to destination"""
        if source_info["type"] == "cloud":
            return await self.download_from_cloud(source_info["path"], dest_path)
        else:
            # Local or NAS - use regular file copy
            try:
                return await asyncio.to_thread(
                    self._copy_file_sync, source_info["path"], dest_path
                )
            except Exception as e:
                logging.error(f"Failed to copy from {source_info['path']}: {e}")
                return False
    
    async def toggle_local_storage(self, recording) -> Dict[str, Any]:
        """Toggle local storage for a recording"""
        has_local = recording.local_audio and os.path.exists(recording.local_audio)
        
        if has_local:
            # Check if this is the only storage location
            if self.count_storage_locations(recording) <= 1:
                return {"success": False, "error": "Cannot delete the only remaining copy"}
            
            # Delete local file
            try:
                await asyncio.to_thread(self._remove_file_sync, recording.local_audio)
                await RecordingService.update_recording(recording.id, local_audio=None)
                return {"success": True, "action": "deleted", "message": "Deleted local file"}
            except Exception as e:
                return {"success": False, "error": f"Failed to delete local file: {e}"}
        else:
            # Copy from first available source to local
            source_info = await self.get_first_available_source(recording)
            if not source_info:
                return {"success": False, "error": "No source file available to copy"}
            
            try:
                # Ensure local recordings directory exists
                local_dir = "recordings"
                os.makedirs(local_dir, exist_ok=True)
                
                local_path = os.path.join(local_dir, storage_name(recording, source_info["path"]))
                
                if await self.copy_from_source(source_info, local_path):
                    await RecordingService.update_recording(recording.id, local_audio=local_path)
                    return {"success": True, "action": "copied", "message": f"Copied to local from {source_info['type']}: {local_path}"}
                else:
                    return {"success": False, "error": f"Failed to copy from {source_info['type']}"}
            except Exception as e:
                return {"success": False, "error": f"Failed to copy to local: {e}"}
    
    async def toggle_nas_storage(self, recording) -> Dict[str, Any]:
        """Toggle NAS storage for a recording"""
        has_nas = recording.nas_audio and os.path.exists(recording.nas_audio)
        
        if has_nas:
            # Check if this is the only storage location
            if self.count_storage_locations(recording) <= 1:
                return {"success": False, "error": "Cannot delete the only remaining copy"}
            
            # Delete NAS file
            try:
                await asyncio.to_thread(self._remove_file_sync, recording.nas_audio)
                await RecordingService.update_recording(recording.id, nas_audio=None)
                return {"success": True, "action": "deleted", "message": "Deleted NAS file"}
            except Exception as e:
                return {"success": False, "error": f"Failed to delete NAS file: {e}"}
        else:
            # Copy from first available source to NAS
            source_info = await self.get_first_available_source(recording)
            if not source_info:
                return {"success": False, "error": "No source file available to copy"}
            
            if not os.path.exists(self.nas_dir):
                return {"success": False, "error": f"NAS directory not available: {self.nas_dir}"}
            
            try:
                nas_path = os.path.join(self.nas_dir, storage_name(recording, source_info["path"]))
                
                if await self.copy_from_source(source_info, nas_path):
                    await RecordingService.update_recording(recording.id, nas_audio=nas_path)
                    return {"success": True, "action": "copied", "message": f"Copied to NAS from {source_info['type']}: {nas_path}"}
                else:
                    return {"success": False, "error": f"Failed to copy from {source_info['type']}"}
            except Exception as e:
                return {"success": False, "error": f"Failed to copy to NAS: {e}"}
    
    async def toggle_cloud_storage(self, recording) -> Dict[str, Any]:
        """Cloud mutations and credentials belong to the backend."""
        try:
            if getattr(recording, "audio_object_key", None) or recording.audio_url:
                if self.count_storage_locations(recording) <= 1:
                    return {"success": False, "error": "Cannot delete the only remaining copy"}
                await self.cloud.delete_audio(recording.id)
                return {"success": True, "action": "deleted", "message": "Deleted B2 audio"}
            source = await self.get_first_available_source(recording)
            if not source or source["type"] == "cloud":
                return {"success": False, "error": "No local or NAS audio to upload"}
            return await self.cloud.upload(recording, source["path"])
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def delete_from_all_storage(self, recording) -> Dict[str, Any]:
        """Delete recording from all storage locations"""
        deleted_locations = []
        errors = []
        # Check authorization and finish cloud deletion before touching local copies.
        try:
            await self.cloud.delete_audio(recording.id)
        except Exception as e:
            return {"deleted_locations": [], "errors": [str(e)], "success": False}
        
        # Delete from local
        if recording.local_audio and os.path.exists(recording.local_audio):
            try:
                os.remove(recording.local_audio)
                deleted_locations.append("local")
            except Exception as e:
                errors.append(f"Failed to delete local file: {e}")
        
        # Delete from NAS
        if recording.nas_audio and os.path.exists(recording.nas_audio):
            try:
                os.remove(recording.nas_audio)
                deleted_locations.append("NAS")
            except Exception as e:
                errors.append(f"Failed to delete NAS file: {e}")
        
        # Backend deletion also tombstones completed uploads so retries cannot recreate them.
        if not errors:
            try:
                await self.cloud.delete_recording(recording.id)
                deleted_locations.append("backend")
            except Exception as e:
                errors.append(f"Failed to delete recording: {e}")
        
        return {
            "deleted_locations": deleted_locations,
            "errors": errors,
            "success": not errors
        }
