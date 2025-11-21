import asyncio
import base64
import hashlib
import hmac
import os
from datetime import datetime, timezone
from typing import Dict, Optional
from urllib.parse import quote

import requests
from dotenv import load_dotenv

load_dotenv()


class AzureBlobStorage:
    def __init__(self, connection_string: str):
        self.connection_string = connection_string
        self.account_name = None
        self.account_key = None
        self.endpoint_suffix = "core.windows.net"
        
        self._parse_connection_string()
    
    def _parse_connection_string(self):
        """Parse Azure connection string to extract account name and key"""
        parts = self.connection_string.split(';')
        for part in parts:
            if part.startswith('AccountName='):
                self.account_name = part.split('=', 1)[1]
            elif part.startswith('AccountKey='):
                self.account_key = part.split('=', 1)[1]
            elif part.startswith('EndpointSuffix='):
                self.endpoint_suffix = part.split('=', 1)[1]
    
    def _get_authorization_header(self, method: str, url_path: str, headers: dict) -> str:
        """Generate Azure Storage authorization header"""
        # Construct the string to sign
        string_to_sign_parts = [
            method.upper(),
            headers.get('Content-Encoding', ''),
            headers.get('Content-Language', ''),
            headers.get('Content-Length', ''),
            headers.get('Content-MD5', ''),
            headers.get('Content-Type', ''),
            headers.get('Date', ''),
            headers.get('If-Modified-Since', ''),
            headers.get('If-Match', ''),
            headers.get('If-None-Match', ''),
            headers.get('If-Unmodified-Since', ''),
            headers.get('Range', ''),
        ]
        
        # Add canonicalized headers
        canonical_headers = []
        for key in sorted(headers.keys()):
            if key.lower().startswith('x-ms-'):
                canonical_headers.append(f"{key.lower()}:{headers[key]}")
        
        if canonical_headers:
            string_to_sign_parts.append('\n'.join(canonical_headers))
        else:
            string_to_sign_parts.append('')
        
        # Add canonicalized resource
        string_to_sign_parts.append(f"/{self.account_name}{url_path}")
        
        string_to_sign = '\n'.join(string_to_sign_parts)
        
        # Sign the string
        decoded_key = base64.b64decode(self.account_key)
        signature = base64.b64encode(
            hmac.new(decoded_key, string_to_sign.encode('utf-8'), hashlib.sha256).digest()
        ).decode('utf-8')
        
        return f"SharedKey {self.account_name}:{signature}"
    
    def _upload_file_sync(
        self, file_path: str, container_name: str, blob_name: Optional[str]
    ) -> Dict[str, object]:
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        if blob_name is None:
            blob_name = os.path.basename(file_path)

        encoded_blob_name = quote(blob_name)
        url_path = f"/{container_name}/{encoded_blob_name}"
        url = f"https://{self.account_name}.blob.{self.endpoint_suffix}{url_path}"

        with open(file_path, "rb") as f:
            file_content = f.read()

        file_size = len(file_content)

        utc_now = datetime.now(timezone.utc)
        headers = {
            "x-ms-date": utc_now.strftime("%a, %d %b %Y %H:%M:%S GMT"),
            "x-ms-version": "2020-04-08",
            "x-ms-blob-type": "BlockBlob",
            "Content-Length": str(file_size),
            "Content-Type": "audio/wav",
        }

        auth_header = self._get_authorization_header("PUT", url_path, headers)
        headers["Authorization"] = auth_header

        response = requests.put(url, data=file_content, headers=headers)

        if response.status_code in [200, 201]:
            return {
                "success": True,
                "url": url,
                "blob_name": blob_name,
                "container": container_name,
                "size": file_size,
            }

        return {
            "success": False,
            "error": f"Upload failed: {response.status_code} - {response.text}",
            "status_code": response.status_code,
        }

    def _delete_file_sync(self, blob_name: str, container_name: str) -> Dict[str, object]:
        encoded_blob_name = quote(blob_name)
        url_path = f"/{container_name}/{encoded_blob_name}"
        url = f"https://{self.account_name}.blob.{self.endpoint_suffix}{url_path}"

        utc_now = datetime.now(timezone.utc)
        headers = {
            "x-ms-date": utc_now.strftime("%a, %d %b %Y %H:%M:%S GMT"),
            "x-ms-version": "2020-04-08",
        }

        auth_header = self._get_authorization_header("DELETE", url_path, headers)
        headers["Authorization"] = auth_header

        response = requests.delete(url, headers=headers)

        if response.status_code in [200, 202, 404]:
            return {
                "success": True,
                "blob_name": blob_name,
                "container": container_name,
            }

        return {
            "success": False,
            "error": f"Delete failed: {response.status_code} - {response.text}",
            "status_code": response.status_code,
        }

    async def upload_file(
        self,
        file_path: str,
        container_name: str = "sec-recordings",
        blob_name: Optional[str] = None,
    ) -> Dict[str, object]:
        """Upload a file to Azure Blob Storage"""
        return await asyncio.to_thread(
            self._upload_file_sync, file_path, container_name, blob_name
        )

    async def delete_file(
        self, blob_name: str, container_name: str = "sec-recordings"
    ) -> Dict[str, object]:
        """Delete a file from Azure Blob Storage"""
        return await asyncio.to_thread(
            self._delete_file_sync, blob_name, container_name
        )
