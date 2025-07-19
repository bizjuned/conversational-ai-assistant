# backend/app/api/voice.py
from fastapi import APIRouter, Query, HTTPException
import logging
import os

# Import your LiveKit service function
from app.services.livekit_service import create_livekit_token

router = APIRouter()
logging.basicConfig(level=logging.INFO) # Ensure logging is configured for this module

@router.get("/livekit-token")
async def get_livekit_token(
    room_name: str = Query(..., description="The name of the LiveKit room to join"),
    identity: str = Query(None, description="Optional: User identity for the LiveKit token")
):
    """
    Generates a LiveKit access token for joining a specific room.
    """
    try:
        user_identity = identity if identity else f"user_{os.urandom(4).hex()}"
        
        token = create_livekit_token(room_name, user_identity)
        logging.info(f"Generated LiveKit token for room: {room_name}, identity: {user_identity}")
        return {"token": token}
    except ValueError as e:
        logging.error(f"Configuration error generating LiveKit token: {e}")
        raise HTTPException(status_code=500, detail=f"Server configuration error: {e}")
    except Exception as e:
        logging.error(f"Error generating LiveKit token: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to generate LiveKit token.")

# You can add other voice-related endpoints here if needed