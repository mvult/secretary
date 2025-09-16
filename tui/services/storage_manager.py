import os
import shutil
import requests
from typing import Optional, Dict, Any
from services.azure_storage import AzureBlobStorage
from db.service import RecordingService
import logging


class StorageManager:
    def __init__(self):
        self.nas_dir = "/Volumes/s3/sec-recordings"
        self.azure_storage = AzureBlobStorage(
            os.getenv("AZURE_CONNECTION_STRING")
        )
    
    async def download_from_cloud(self, url: str, dest_path: str) -> bool:
        """Download file from cloud URL to local path"""
        try:
            response = requests.get(url, stream=True)
            response.raise_for_status()
            
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            
            with open(dest_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            return True
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
        if recording.audio_url and recording.audio_url.startswith('https://'):
            return {"type": "cloud", "path": recording.audio_url}
        
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
        if recording.audio_url and recording.audio_url.startswith('https://'):
            count += 1
            
        return count
    
    async def copy_from_source(self, source_info: Dict[str, str], dest_path: str) -> bool:
        """Copy file from source to destination"""
        if source_info["type"] == "cloud":
            return await self.download_from_cloud(source_info["path"], dest_path)
        else:
            # Local or NAS - use regular file copy
            try:
                shutil.copy2(source_info["path"], dest_path)
                return True
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
                os.remove(recording.local_audio)
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
                
                local_path = os.path.join(local_dir, f"{recording.id}_{recording.name}.wav")
                
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
                os.remove(recording.nas_audio)
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
                nas_path = os.path.join(self.nas_dir, f"{recording.id}_{recording.name}.wav")
                
                if await self.copy_from_source(source_info, nas_path):
                    await RecordingService.update_recording(recording.id, nas_audio=nas_path)
                    return {"success": True, "action": "copied", "message": f"Copied to NAS from {source_info['type']}: {nas_path}"}
                else:
                    return {"success": False, "error": f"Failed to copy from {source_info['type']}"}
            except Exception as e:
                return {"success": False, "error": f"Failed to copy to NAS: {e}"}
    
    async def toggle_cloud_storage(self, recording) -> Dict[str, Any]:
        """Toggle cloud storage for a recording"""
        has_cloud = recording.audio_url and recording.audio_url.startswith('https://')
        
        if has_cloud:
            # Check if this is the only storage location
            if self.count_storage_locations(recording) <= 1:
                return {"success": False, "error": "Cannot delete the only remaining copy"}
            
            # Delete cloud file
            try:
                blob_name = f"{recording.id}_{recording.name}.wav"
                result = await self.azure_storage.delete_file(blob_name)
                
                if result['success']:
                    await RecordingService.update_recording(recording.id, audio_url=None)
                    return {"success": True, "action": "deleted", "message": "Deleted cloud file"}
                else:
                    return {"success": False, "error": f"Failed to delete cloud file: {result.get('error', 'Unknown error')}"}
            except Exception as e:
                return {"success": False, "error": f"Failed to delete cloud file: {e}"}
        else:
            # Upload from first available source to cloud
            source_info = await self.get_first_available_source(recording)
            if not source_info:
                return {"success": False, "error": "No source file available to upload"}
            
            try:
                # If source is cloud, we can't upload it to cloud (that would be pointless)
                if source_info["type"] == "cloud":
                    return {"success": False, "error": "Cannot upload cloud file to cloud"}
                
                result = await self.azure_storage.upload_file(
                    source_info["path"],
                    blob_name=f"{recording.id}_{recording.name}.wav"
                )
                
                if result['success']:
                    await RecordingService.update_recording(recording.id, audio_url=result['url'])
                    return {"success": True, "action": "uploaded", "message": f"Uploaded to cloud from {source_info['type']}: {result['url']}"}
                else:
                    return {"success": False, "error": result.get('error', 'Upload failed')}
            except Exception as e:
                return {"success": False, "error": f"Failed to upload to cloud: {e}"}
    
    async def delete_from_all_storage(self, recording) -> Dict[str, Any]:
        """Delete recording from all storage locations"""
        deleted_locations = []
        errors = []
        
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
        
        # Delete from cloud
        if recording.audio_url and recording.audio_url.startswith('https://'):
            try:
                blob_name = f"{recording.id}_{recording.name}.wav"
                result = await self.azure_storage.delete_file(blob_name)
                if result['success']:
                    deleted_locations.append("cloud")
                else:
                    errors.append(f"Failed to delete cloud file: {result.get('error', 'Unknown error')}")
            except Exception as e:
                errors.append(f"Failed to delete cloud file: {e}")
        
        return {
            "deleted_locations": deleted_locations,
            "errors": errors,
            "success": len(deleted_locations) > 0
        }