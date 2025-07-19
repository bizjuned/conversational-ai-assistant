# app/core/main.py
import os
import logging
import asyncio
import sys
import json
import base64

# Configure root logger to show INFO messages
logging.basicConfig(level=logging.INFO)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from sse_starlette.sse import EventSourceResponse

# Import our provider factory
from app.providers.factory import get_stt_provider, get_llm_provider, get_tts_provider

from app.api.chat import router as chat_router
from app.api.voice import router as voice_router

from deepgram import LiveOptions, LiveTranscriptionEvents

load_dotenv()

# --- Initialize Providers using the factory ---
stt_provider = get_stt_provider()
llm_provider = get_llm_provider() if (os.getenv("GOOGLE_API_KEY") or os.getenv("OPENAI_API_KEY")) else None
tts_provider = get_tts_provider() if os.getenv("ELEVENLABS_API_KEY") or os.getenv("GOOGLE_API_KEY") else None

# --- NEW DEBUG LINE ---
logging.info(f"TTS_PROVIDER inside container is: {os.getenv('TTS_PROVIDER')}")


app = FastAPI()
# Using an asyncio.Queue for SSE is generally less ideal for real-time
# streaming data that maps directly to a WebSocket.
# For audio, it's often better to send directly over the WebSocket
# or use a more robust messaging pattern if SSE is truly needed for out-of-band events.
# For now, we will adapt to send audio chunks via SSE.
response_queue = asyncio.Queue()

# --- SSE Endpoint ---
@app.get("/api/sse")
async def sse_endpoint(request: Request):
    async def event_generator():
        while True:
            if await request.is_disconnected():
                logging.info("SSE client disconnected.")
                break
            try:
                # This queue will now receive JSON strings representing audio chunks or other events
                response_json = await response_queue.get()
                yield {"data": response_json}
            except asyncio.CancelledError:
                logging.info("SSE event generator cancelled.")
                break
            except Exception as e:
                logging.error(f"Error in SSE event generator: {e}")
                await asyncio.sleep(1) # Prevent tight loop on error
    return EventSourceResponse(event_generator())

# --- WebSocket Endpoint ---
@app.websocket("/api/ws/audio")
async def websocket_endpoint(websocket: WebSocket):
    transcriber = None
    try:
        await websocket.accept()
        logging.info("WebSocket connection established.")

        options = LiveOptions(
            model="nova-2", punctuate=True, language="en-US",
            encoding="opus", channels=1, interim_results=False,
            endpointing=300, smart_format=True
        )
        transcriber = stt_provider.get_transcriber(options)

        await transcriber.start(options)
        logging.info("Connected to STT provider.")

        async def process_transcript_and_respond(transcript: str):
            if not llm_provider or not tts_provider:
                logging.warning("LLM or TTS provider not available. Check API keys.")
                return
            try:
                llm_response_text = await llm_provider.generate_response(transcript)
                logging.info(f"LLM Response: '{llm_response_text}'")

                # --- CRITICAL CHANGE HERE ---
                # Iterate over the async generator returned by synthesize
                async for audio_chunk in tts_provider.synthesize(llm_response_text):
                    if not audio_chunk: # Skip empty chunks
                        continue

                    # Each audio_chunk is already bytes. Base64 encode it.
                    encoded_audio_chunk = base64.b64encode(audio_chunk).decode('utf-8')

                    # Prepare payload for each chunk
                    # You might want to include transcript/LLM response only on the first chunk
                    # or only when the full transcript is ready.
                    # For simplicity, sending with each chunk now.
                    payload = {
                        "type": "audio_chunk", # Changed type to indicate it's a chunk
                        "transcript": transcript, # This will be repeated for each chunk
                        "llm_response_text": llm_response_text, # Also repeated
                        "audio_chunk": encoded_audio_chunk # Key changed to reflect chunk
                    }
                    await response_queue.put(json.dumps(payload))
                    # Optionally log each chunk sent:
                    # logging.debug(f"Queued TTS audio chunk of size {len(audio_chunk)} bytes for SSE.")

                logging.info(f"Finished queuing all TTS audio chunks for '{llm_response_text}'.")
            except Exception as e:
                logging.error(f"Error during AI processing (TTS or LLM): {e}", exc_info=True) # exc_info for full traceback

        async def on_message(self, result, **kwargs):
            transcript = result.channel.alternatives[0].transcript
            if transcript:
                logging.info(f"STT TRANSCRIPT: '{transcript}'")
                # Create a task to process the response without blocking the STT transcriber
                asyncio.create_task(process_transcript_and_respond(transcript))

        transcriber.on(LiveTranscriptionEvents.Transcript, on_message)

        while True:
            # This loop receives audio from the frontend
            audio_chunk = await websocket.receive_bytes()
            if transcriber:
                await transcriber.send(audio_chunk) # Send to Deepgram STT

    except WebSocketDisconnect:
        logging.info("Frontend WebSocket disconnected.")
    except Exception as e:
        logging.error(f"Unhandled error in WebSocket endpoint: {e}", exc_info=True)
    finally:
        if transcriber:
            await transcriber.finish() # Ensure Deepgram connection is closed
            logging.info("STT transcriber finished.")
        logging.info("WebSocket process complete.")


# --- Middleware, Routers, and Health Check ---
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.include_router(chat_router, prefix="/api")
app.include_router(voice_router, prefix="/api")
@app.get("/")
async def health_check():
    return {"status": "ok"}