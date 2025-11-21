import asyncio
import logging
import os
from typing import Any, Dict

import requests
from dotenv import load_dotenv

load_dotenv()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")


def _transcribe_from_url_sync(audio_url: str) -> Dict[str, Any]:
    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}",
        "Content-Type": "application/json",
    }

    params = {
        "diarize": "true",
        "model": "nova-3-general",
        "smart_format": "true",
        "language": "multi",
    }

    payload = {"url": audio_url}

    response = requests.post(
        "https://api.deepgram.com/v1/listen",
        headers=headers,
        params=params,
        json=payload,
    )

    if response.status_code == 200:
        result = response.json()
        logging.info("Deepgram response structure: %s", result.keys())
        transcript = result["results"]["channels"][0]["alternatives"][0]["paragraphs"][
            "transcript"
        ]
        return {"success": True, "transcript": transcript}

    return {
        "success": False,
        "error": f"Deepgram API error: {response.status_code} - {response.text}",
    }


def _transcribe_from_file_sync(file_path: str) -> Dict[str, Any]:
    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}",
        "Content-Type": "audio/wav",
    }

    params = {
        "diarize": "true",
        "model": "nova-3-general",
        "smart_format": "true",
        "language": "multi",
    }

    with open(file_path, "rb") as audio_file:
        response = requests.post(
            "https://api.deepgram.com/v1/listen",
            headers=headers,
            params=params,
            data=audio_file,
        )

    if response.status_code == 200:
        result = response.json()
        logging.info("Deepgram response structure: %s", result.keys())
        transcript = result["results"]["channels"][0]["alternatives"][0]["paragraphs"][
            "transcript"
        ]
        return {"success": True, "transcript": transcript}

    return {
        "success": False,
        "error": f"Deepgram API error: {response.status_code} - {response.text}",
    }


async def transcribe_from_url(audio_url: str) -> Dict[str, Any]:
    try:
        return await asyncio.to_thread(_transcribe_from_url_sync, audio_url)
    except Exception as exc:
        logging.error("Error transcribing audio: %s", exc)
        return {"success": False, "error": f"Transcription failed: {exc}"}


async def transcribe_from_file(file_path: str) -> Dict[str, Any]:
    try:
        return await asyncio.to_thread(_transcribe_from_file_sync, file_path)
    except Exception as exc:
        logging.error("Error transcribing file %s: %s", file_path, exc)
        return {"success": False, "error": f"Transcription failed: {exc}"}
