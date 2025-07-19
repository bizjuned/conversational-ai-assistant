# app/api/voice.py
from fastapi import APIRouter # Remove WebSocket, WebSocketDisconnect from import
from app.services.livekit_service import create_livekit_token
import uuid
import logging 

# Remove AssemblyAI/Deepgram and os imports if only used in WS endpoint
# import assemblyai as aai 
# import os 
# from deepgram import DeepgramClient, LiveTranscriptionEvents, LiveOptions # Remove these

router = APIRouter()

# --- Deepgram Configuration (REMOVE from here - moved to main.py) ---
# DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
# if not DEEPGRAM_API_KEY:
#    logging.error("DEEPGRAM_API_KEY environment variable not set...")
# else:
#    pass


@router.get("/livekit-token")
async def get_livekit_token(room_name: str = "ai-voice-bot"):
    """
    Generates a LiveKit access token for the client.
    """
    identity = str(uuid.uuid4()) 
    
    try:
        token = create_livekit_token(room_name, identity) 
        return {"token": token, "identity": identity}
    except ValueError as e:
        logging.error(f"Error generating LiveKit token: {e}")
        return {"error": str(e)}

# --- REMOVE THE ENTIRE WEBSOCKET ENDPOINT FROM THIS FILE! ---
# @router.websocket("/ws/audio")
# async def websocket_endpoint(websocket: WebSocket):
#     # ... (all WebSocket logic including Deepgram, etc.) ...