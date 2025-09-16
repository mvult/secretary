from openai import OpenAI
import os
from dotenv import load_dotenv

load_dotenv()

OPENROUTER_API_KEY = os.getenv('OPENROUTER_API_KEY')

# Common OpenAI client configuration
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=OPENROUTER_API_KEY,
)

def get_openai_client():
    """Get the configured OpenAI client"""
    return client

def is_openai_configured():
    """Check if OpenAI API key is configured"""
    return bool(OPENROUTER_API_KEY)