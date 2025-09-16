from typing import Dict, Any, List
import logging
import json
from .openai_client import get_openai_client, is_openai_configured


async def analyze_transcript(transcript: str, analysis_type: str, recording_id: int = None) -> Dict[str, Any]:
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
            prompt = """Extract all TODO items, action items, tasks, and follow-ups from this transcript. 
Return ONLY a JSON object with this exact structure:
{
  "todos": [
    {
      "name": "Brief title of the task",
      "desc": "Detailed description of what needs to be done",
      "status": "pending"
    }
  ]
}

If no TODOs are found, return: {"todos": []}

Transcript:
""" + transcript
            
        elif analysis_type == "summary":
            prompt = "Provide a concise summary of this transcript in 2-3 sentences:\n\n" + transcript
        else:
            return {
                "type": analysis_type,
                "title": "Unknown Analysis",
                "content": f"Unknown analysis type: {analysis_type}",
                "error": True
            }
        
        client = get_openai_client()
        result = client.responses.create(
            model="gpt-5",
            input=prompt,
            reasoning={"effort": "low"},
            text={"verbosity": "low"},
        )
        
        content = result.text.content
        
        if analysis_type == "todos":
            try:
                # Parse JSON response for TODOs
                todo_data = json.loads(content)
                todos = todo_data.get("todos", [])
                
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