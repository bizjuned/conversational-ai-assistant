# app/services/livekit_service.py
import os
import uuid
import jwt
import time
from typing import Dict, Any

# Get LiveKit API credentials from environment variables
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY_SERVER")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET_SERVER")

# Define the structure for LiveKit VideoGrant permissions
def create_video_grant(room_name: str) -> Dict[str, Any]:
    return {
        "roomJoin": True,
        "room": room_name,
        "canPublish": True,
        "canSubscribe": True,
        "canPublishSources": ["microphone"], 
    }

def create_livekit_token(room_name: str, identity: str) -> str:
    """Generates a LiveKit access token using PyJWT."""

    if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
        raise ValueError("LiveKit API Key or Secret not set in environment variables.")

    # Define the grant
    video_grant = create_video_grant(room_name)

    # JWT Payload structure for LiveKit
    payload = {
        "jti": str(uuid.uuid4()),               # Unique token ID
        "iat": int(time.time()),                # Issued at
        "exp": int(time.time()) + 86400,        # Expires in 24 hours (for testing)
        "iss": LIVEKIT_API_KEY,                 # Issuer (API Key)
        "sub": identity,                        # Subject (user identity)
        "video": video_grant                    # LiveKit video grants
    }

    # Sign the payload using the API Secret
    jwt_token = jwt.encode(
        payload,
        LIVEKIT_API_SECRET,
        algorithm="HS256"
    )

    return jwt_token