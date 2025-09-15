import requests
from typing import Optional, Dict, Any
import logging
import os
from dotenv import load_dotenv

load_dotenv()

DEEPGRAM_API_KEY = os.getenv('DEEPGRAM_API_KEY')


async def transcribe_from_url(audio_url: str) -> Dict[str, Any]:
    """Transcribe audio from a URL using Deepgram API"""
    try:
        headers = {
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": "application/json"
        }
        
        params = {
            "diarize": "true",
            "model": "nova-3-general", 
            "smart_format": "true",
            "language": "multi"
        }
        
        payload = {
            "url": audio_url
        }
        
        response = requests.post(
            "https://api.deepgram.com/v1/listen",
            headers=headers,
            params=params,
            json=payload
        )
        
        if response.status_code == 200:
            result = response.json()
            transcript = result['results']['channels'][0]['alternatives'][0]['paragraphs']['transcript']
            return {
                "success": True,
                "transcript": transcript
            }
        else:
            return {
                "success": False,
                "error": f"Deepgram API error: {response.status_code} - {response.text}"
            }
            
    except Exception as e:
        logging.error(f"Error transcribing audio: {e}")
        return {
            "success": False,
            "error": f"Transcription failed: {e}"
        }


async def transcribe_from_file(file_path: str) -> Dict[str, Any]:
    """Transcribe audio from a local file using Deepgram API"""
    try:
        headers = {
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": "audio/wav"
        }
        
        params = {
            "diarize": "true",
            "model": "nova-3-general",
            "smart_format": "true", 
            "language": "multi"
        }
        
        with open(file_path, 'rb') as audio_file:
            response = requests.post(
                "https://api.deepgram.com/v1/listen",
                headers=headers,
                params=params,
                data=audio_file
            )
        
        if response.status_code == 200:
            result = response.json()
            transcript = result['results']['channels'][0]['alternatives'][0]['paragraphs']['transcript']
            return {
                "success": True,
                "transcript": transcript
            }
        else:
            return {
                "success": False,
                "error": f"Deepgram API error: {response.status_code} - {response.text}"
            }
            
    except Exception as e:
        logging.error(f"Error transcribing file {file_path}: {e}")
        return {
            "success": False,
            "error": f"Transcription failed: {e}"
        }