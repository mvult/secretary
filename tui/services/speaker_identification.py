import asyncio
import json
import logging
from typing import Any, Dict, List

from .openai_client import get_openai_client, is_openai_configured


def _identify_speakers_sync(prompt: str) -> Any:
    client = get_openai_client()
    return client.chat.completions.create(
        model="openai/gpt-5",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )


async def identify_speakers_in_transcript(transcript: str, users: List[Dict], recording_id: int) -> Dict[str, Any]:
    """Identify which speakers correspond to which users based on transcript content"""
    if not transcript or not users:
        return {
            "success": False,
            "error": "Missing transcript or users list"
        }
    
    if not is_openai_configured():
        return {
            "success": False,
            "error": "OpenRouter API key not configured"
        }
    
    try:
        # Format users list for prompt
        users_info = []
        for user in users:
            user_str = f"ID: {user['id']}, Name: {user['first_name']} {user['last_name']}"
            if user.get('role'):
                user_str += f", Role: {user['role']}"
            users_info.append(user_str)
        
        prompt = f"""Analyze this diarized transcript and identify which speaker corresponds to which user based on contextual clues like:
- Direct name mentions ("My name is...", "I'm...")
- People addressing each other by name
- Role or title references
- Context clues from conversation flow

Users available:
{chr(10).join(users_info)}

Transcript:
{transcript}

Return ONLY a JSON object with this exact structure:
{{
  "speaker_mappings": [
    {{
      "speaker_id": "Speaker 0",
      "user_id": 123,
      "confidence": "high|medium|low",
      "reasoning": "Brief explanation of why this mapping was made"
    }}
  ]
}}

If you cannot confidently identify a speaker, do not include them in the mappings.
"""
        
        result = await asyncio.to_thread(_identify_speakers_sync, prompt)
        content = result.choices[0].message.content
        
        try:
            # Parse JSON response
            mapping_data = json.loads(content)
            mappings = mapping_data.get("speaker_mappings", [])
            
            return {
                "success": True,
                "mappings": mappings,
                "recording_id": recording_id,
                "raw_response": content
            }
        except json.JSONDecodeError:
            return {
                "success": False,
                "error": f"Failed to parse JSON response: {content}"
            }
            
    except Exception as e:
        logging.error(f"Error identifying speakers: {e}")
        return {
            "success": False,
            "error": f"Speaker identification failed: {e}"
        }
