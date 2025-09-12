from tortoise import Tortoise
import logging
from urllib.parse import urlparse, parse_qs, urlunparse

# Database configuration - leave connection string blank as requested
DB_CONNECTION_STRING = "postgresql://neondb_owner:npg_PeyF4Zchz8Ij@ep-dark-heart-aas802qy-pooler.westus3.azure.neon.tech/neondb?sslmode=require&channel_binding=require"


def convert_postgres_url_for_tortoise(url: str) -> str:
    """Convert PostgreSQL URL to format compatible with Tortoise ORM/asyncpg"""
    parsed = urlparse(url)
    
    # Change scheme from postgresql to postgres
    scheme = "postgres" if parsed.scheme == "postgresql" else parsed.scheme
    
    # Parse query parameters
    query_params = parse_qs(parsed.query)
    
    # Convert sslmode to ssl parameter for asyncpg
    new_query_parts = []
    for key, values in query_params.items():
        if key == "sslmode":
            if values[0] == "require":
                new_query_parts.append("ssl=true")
        elif key == "channel_binding":
            # Skip channel_binding as asyncpg doesn't support it
            continue
        else:
            # Keep other parameters
            for value in values:
                new_query_parts.append(f"{key}={value}")
    
    new_query = "&".join(new_query_parts)
    
    # Reconstruct URL
    new_parsed = parsed._replace(scheme=scheme, query=new_query)
    return urlunparse(new_parsed)


async def init_database():
    """Initialize Tortoise ORM with database connection"""
    if not DB_CONNECTION_STRING:
        logging.warning("Database connection string is empty")
        return False

    try:
        # Convert URL for Tortoise ORM compatibility
        db_url = convert_postgres_url_for_tortoise(DB_CONNECTION_STRING)
        logging.info(f"Connecting to database with URL: {db_url}")
        
        await Tortoise.init(
            db_url=db_url, modules={"models": ["db.models"]}
        )
        return True
    except Exception as e:
        logging.error(f"Database initialization failed: {e}")
        return False


async def close_database():
    """Close database connections"""
    await Tortoise.close_connections()

