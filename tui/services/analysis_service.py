import asyncio
import json
import logging
from typing import Any, Dict, List, Tuple

from .openai_client import get_openai_client, is_openai_configured


def _run_completion_sync(prompt: str) -> Tuple[Any, Dict[str, str]]:
    client = get_openai_client()
    result = client.chat.completions.create(
        model="openai/gpt-5",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )

    meta: Dict[str, str] = {}
    if hasattr(result, "_request_id"):
        meta["request_id"] = result._request_id  # type: ignore[attr-defined]
    if hasattr(result, "model"):
        meta["model"] = result.model  # type: ignore[attr-defined]
    if hasattr(result, "_raw_response"):
        headers = getattr(result._raw_response, "headers", {})
        if "x-or-model" in headers:
            meta["header_model"] = headers["x-or-model"]

    return result, meta


async def analyze_transcript(transcript: str, analysis_type: str, recording_id: int = None, speaker_mappings: List[Dict] = None) -> Dict[str, Any]:
    """Analyze transcript using OpenAI GPT-5 via OpenRouter"""
    if not transcript:
        return {
            "type": analysis_type,
            "title": f"{analysis_type.title()} Analysis",
            "content": "No transcript available to analyze.",
            "error": True
        }
    
    if not is_openai_configured():
        return {
            "type": analysis_type,
            "title": f"{analysis_type.title()} Analysis", 
            "content": "OpenRouter API key not configured.",
            "error": True
        }
    
    try:
        if analysis_type == "todos":
            # Build speaker context
            speaker_context = ""
            if speaker_mappings:
                logging.info(f"Speaker mappings received: {speaker_mappings}")
                from db.service import UserService
                users = await UserService.get_all_users()
                user_map = {user.id: f"{user.first_name} {user.last_name}" for user in users}
                logging.info(f"User map: {user_map}")
                
                speaker_context = "\n\nSpeaker Mappings:\n"
                for mapping in speaker_mappings:
                    user_name = user_map.get(mapping.get("user_id"), f"User {mapping.get('user_id')}")
                    speaker_context += f"Speaker {mapping.get('speaker_id')}: {user_name} (user_id: {mapping.get('user_id')})\n"
                
                logging.info(f"Speaker context built: {speaker_context}")
            
            prompt = f"""Analyze this conversation transcript and extract all action items, tasks, and commitments made by the speakers.

{speaker_context}

IMPORTANT INSTRUCTIONS:
1. Look for explicit task assignments and who agrees to do what
2. Pay careful attention to WHO is responsible for each task
3. When someone assigns a task to another person, assign it to that person
4. When someone accepts or commits to doing something, assign it to them
5. Group related tasks logically when it makes sense

Return your response in English, and return ONLY a JSON object with this exact structure:
{{
  "todos": [
    {{
      "name": "Brief title of the task in English (max 100 chars)",
      "desc": "Detailed description in English of what needs to be done",
      "status": "pending",
      "user_id": 123
    }}
  ]
}}

ASSIGNMENT RULES:
- Carefully track who is assigned each task based on the conversation flow
- Use the correct user_id from the speaker mappings above
- Only include clear, actionable commitments
- Use null for user_id only if truly unclear who is responsible

Transcript:
{transcript}"""
            
        elif analysis_type == "summary":
            prompt = "Provide a comprehensive summary of this transcript in approximately 200 words. Include key topics discussed, main points, decisions made, any important outcomes, and any pending questions or unresolved issues:\n\n" + transcript
        else:
            return {
                "type": analysis_type,
                "title": "Unknown Analysis",
                "content": f"Unknown analysis type: {analysis_type}",
                "error": True
            }
        
        result, meta = await asyncio.to_thread(_run_completion_sync, prompt)

        if meta.get("request_id"):
            logging.info("OpenRouter request ID: %s", meta["request_id"])
        if meta.get("model"):
            logging.info("OpenRouter actual model used: %s", meta["model"])
        if meta.get("header_model"):
            logging.info("OpenRouter model header: %s", meta["header_model"])

        content = result.choices[0].message.content
        
        if analysis_type == "todos":
            try:
                # Parse JSON response for TODOs
                todo_data = json.loads(content)
                todos = todo_data.get("todos", [])
                
                # Save TODOs to database
                if todos and recording_id:
                    from db.service import TodoService
                    saved_count = 0
                    for todo in todos:
                        success = await TodoService.create_todo(
                            name=todo.get("name"),
                            desc=todo.get("desc"),
                            status=todo.get("status", "pending"),
                            user_id=todo.get("user_id"),
                            created_at_recording_id=recording_id
                        )
                        if success:
                            saved_count += 1
                    
                    logging.info(f"Saved {saved_count}/{len(todos)} TODOs to database for recording {recording_id}")
                
                return {
                    "type": analysis_type,
                    "title": f"Extracted {len(todos)} TODO items",
                    "content": content,
                    "todos": todos,
                    "recording_id": recording_id,
                    "success": True
                }
            except json.JSONDecodeError:
                return {
                    "type": analysis_type,
                    "title": "TODO Analysis",
                    "content": f"Failed to parse JSON response: {content}",
                    "error": True
                }
        else:
            # For summary, also save to database
            if analysis_type == "summary" and recording_id:
                from db.service import RecordingService
                await RecordingService.update_recording(recording_id, summary=content)
            
            return {
                "type": analysis_type,
                "title": f"{analysis_type.title()} Analysis",
                "content": content,
                "success": True
            }
            
    except Exception as e:
        logging.error(f"Error analyzing transcript: {e}")
        return {
            "type": analysis_type,
            "title": f"{analysis_type.title()} Analysis",
            "content": f"Analysis failed: {e}",
            "error": True
        }
