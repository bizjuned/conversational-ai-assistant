# backend/app/core/main.py
import os
import logging
import asyncio
import sys
import json
import base64
import redis # NEW: Import redis

# Deepgram SDK Debug Logging (Keep for now, helps diagnose Deepgram's internal behavior)
import httpx
httpx_logger = logging.getLogger("httpx")
httpx_logger.setLevel(logging.DEBUG) 

deepgram_logger = logging.getLogger("deepgram")
deepgram_logger.setLevel(logging.DEBUG)
# --- End Deepgram SDK Debug Logging ---

# NEW: Import FastAPI components needed for memory and new endpoints
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Body, HTTPException, Query 
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel # NEW: For validating text input in POST request

# NEW: Import LangChain memory components and message utilities
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage, messages_from_dict, messages_to_dict
from langchain_community.chat_message_histories import ChatMessageHistory # NEW: For ChatMessageHistory

# Import our provider factory
from app.providers.factory import get_stt_provider, get_llm_provider, get_tts_provider

# Existing Deepgram imports (ensure these are present and not duplicated)
from deepgram import LiveOptions, LiveTranscriptionEvents

# Existing router imports (DO NOT REMOVE, they are for your existing API structure)
# These will bring in your /api/livekit-token and other chat endpoints
from app.api.chat import router as chat_router
from app.api.voice import router as voice_router # Assumed to contain /api/livekit-token

load_dotenv()

# Configure root logger to show INFO messages
logging.basicConfig(level=logging.INFO) 

# --- Initialize Providers using the factory ---
stt_provider = get_stt_provider()
llm_provider = get_llm_provider() if (os.getenv("GOOGLE_API_KEY") or os.getenv("OPENAI_API_KEY")) else None
tts_provider = get_tts_provider() if os.getenv("ELEVENLABS_API_KEY") or os.getenv("GOOGLE_API_KEY") else None

logging.info(f"STT_PROVIDER: {os.getenv('STT_PROVIDER')}")
logging.info(f"LLM_PROVIDER: {os.getenv('LLM_PROVIDER')}")
logging.info(f"TTS_PROVIDER: {os.getenv('TTS_PROVIDER')}")

app = FastAPI()

# NEW: Initialize Redis client
REDIS_HOST = os.getenv("REDIS_HOST", "localhost") 
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379))
redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=0, decode_responses=True)

# NEW: Helper functions for Redis memory management
async def load_conversation_history(conversation_id: str) -> ChatMessageHistory:
    """Loads chat history for a given conversation_id from Redis."""
    try:
        raw_history = redis_client.get(f"chat_history:{conversation_id}")
        if raw_history:
            messages_dict = json.loads(raw_history)
            messages = messages_from_dict(messages_dict)
            logging.info(f"Loaded history for {conversation_id}: {len(messages)} messages.")
            return ChatMessageHistory(messages=messages)
        else:
            logging.info(f"No history found for {conversation_id}. Starting new.")
            return ChatMessageHistory()
    except Exception as e:
        logging.error(f"Error loading history for {conversation_id}: {e}", exc_info=True)
        return ChatMessageHistory() 


async def save_conversation_history(conversation_id: str, history: ChatMessageHistory):
    """Saves chat history for a given conversation_id to Redis."""
    try:
        messages_dict = messages_to_dict(history.messages)
        redis_client.set(f"chat_history:{conversation_id}", json.dumps(messages_dict))
        logging.info(f"Saved {len(history.messages)} messages for {conversation_id}.")
    except Exception as e:
        logging.error(f"Error saving history for {conversation_id}: {e}", exc_info=True)


# NEW: A more sophisticated queue to hold responses for specific conversation IDs
global_response_queue = asyncio.Queue() 

# --- SSE Endpoint (MODIFIED to filter by conversation_id) ---
@app.get("/api/sse")
async def sse_endpoint(request: Request, conversation_id: str = Query(..., min_length=1)):
    logging.info(f"SSE client connected for conversation_id: {conversation_id}")
    async def event_generator():
        while True:
            if await request.is_disconnected():
                logging.info(f"SSE client disconnected for conversation_id: {conversation_id}.")
                break
            try:
                received_conversation_id, response_json = await global_response_queue.get()
                
                if received_conversation_id == conversation_id:
                    yield {"data": response_json}
                else:
                    await global_response_queue.put((received_conversation_id, response_json))
                    await asyncio.sleep(0.01) 
                    
            except asyncio.CancelledError:
                logging.info(f"SSE event generator cancelled for conversation_id: {conversation_id}.")
                break
            except Exception as e:
                logging.error(f"Error in SSE event generator for {conversation_id}: {e}", exc_info=True)
                await asyncio.sleep(1) 
    return EventSourceResponse(event_generator())

# NEW: Unified AI Processing Function
async def process_text_for_ai(input_text: str, source: str, conversation_id: str): 
    if not llm_provider or not tts_provider:
        logging.warning("LLM or TTS provider not available. Check API keys.")
        await global_response_queue.put((conversation_id, json.dumps({"type": "error", "message": "AI services unavailable.", "source": source})))
        return
    
    history = await load_conversation_history(conversation_id)
    
    try:
        await global_response_queue.put((conversation_id, json.dumps({"type": "ai_thinking", "status": True, "source": source})))
        
        history.add_user_message(input_text)
        
        llm_messages = history.messages
        logging.info(f"Sending {len(llm_messages)} LLM messages for {conversation_id} from {source}: {llm_messages}")

        llm_response_text = await llm_provider.generate_response(llm_messages)
        logging.info(f"LLM Response for {conversation_id} from {source} input: '{llm_response_text}'")

        history.add_ai_message(llm_response_text)
        
        await save_conversation_history(conversation_id, history)

        audio_stream_iterator = tts_provider.synthesize(llm_response_text)
        
        async for audio_chunk in audio_stream_iterator:
            if not audio_chunk:
                logging.debug(f"Received empty audio_chunk from TTS provider for conv_id: {conversation_id}")
                continue 
            
            # --- CRITICAL AUDIO DEBUGGING LOGS ---
            if isinstance(audio_chunk, bytes):
                logging.debug(f"AUDIO_CHUNK_INFO: Type=bytes, Size={len(audio_chunk)} bytes. Conv_id: {conversation_id}")
            else:
                logging.error(f"AUDIO_CHUNK_INFO: UNEXPECTED TYPE={type(audio_chunk)}. Expected bytes. Conv_id: {conversation_id}")
            # --- END CRITICAL AUDIO DEBUGGING LOGS ---

            payload = {
                "type": "audio_chunk",
                "transcript": input_text,       
                "llm_response_text": llm_response_text, 
                "audio_chunk": base64.b64encode(audio_chunk).decode('utf-8') 
            }
            await global_response_queue.put((conversation_id, json.dumps(payload))) 
        
        logging.info(f"Finished queuing all TTS audio chunks for '{llm_response_text}'.")
        await global_response_queue.put((conversation_id, json.dumps({"type": "ai_thinking", "status": False, "source": source}))) 
    except Exception as e:
        logging.error(f"Error during AI processing for {conversation_id} {source} input: {e}", exc_info=True)
        await global_response_queue.put((conversation_id, json.dumps({"type": "error", "message": f"AI processing failed: {e}", "source": source})))
        await global_response_queue.put((conversation_id, json.dumps({"type": "ai_thinking", "status": False, "source": source})))


# --- WebSocket Endpoint for Audio Input (STT) - MODIFIED to use conversation_id and unified processing ---
@app.websocket("/api/ws/audio")
async def websocket_endpoint(websocket: WebSocket, conversation_id: str = Query(..., min_length=1)):
    transcriber = None
    logging.info(f"WebSocket connection established for STT, conversation_id: {conversation_id}")
    try:
        await websocket.accept()

        options = LiveOptions(
            model="nova-2", punctuate=True, language="en-US",
            encoding="opus", channels=1, interim_results=False, 
            endpointing=300, smart_format=True
        )
        transcriber = stt_provider.get_transcriber(options)
        
        await transcriber.start(options)
        logging.info(f"Connected to STT provider for conversation_id: {conversation_id}.")

        async def on_message(self, result, **kwargs): 
            transcript = result.channel.alternatives[0].transcript
            if transcript:
                logging.info(f"STT TRANSCRIPT for {conversation_id}: '{transcript}'")
                asyncio.create_task(process_text_for_ai(transcript, "voice_input", conversation_id))

        transcriber.on(LiveTranscriptionEvents.Transcript, on_message)
        transcriber.on(LiveTranscriptionEvents.Error, lambda self, error, **kwargs: logging.error(f"Deepgram Error for {conversation_id}: {error}"))
        transcriber.on(LiveTranscriptionEvents.Close, lambda self, **kwargs: logging.info(f"Deepgram connection closed for {conversation_id}."))

        while True:
            try:
                audio_chunk = await websocket.receive_bytes()
                if transcriber:
                    await transcriber.send(audio_chunk) 
            except asyncio.CancelledError: 
                logging.info(f"STT WebSocket receive loop cancelled for {conversation_id}.")
                break
            except Exception as e:
                logging.error(f"Error receiving audio chunk for {conversation_id}: {e}", exc_info=True)
                break 

    except WebSocketDisconnect:
        logging.info(f"Frontend WebSocket disconnected for STT, conversation_id: {conversation_id}.")
        if transcriber:
            logging.info(f"Frontend disconnected, signaling Deepgram to finalize for {conversation_id}.")
            try:
                await asyncio.sleep(0.5) 
                await transcriber.finish()
                logging.info(f"Deepgram transcriber finished gracefully after frontend disconnect for {conversation_id}.")
            except Exception as e:
                logging.error(f"Error finalizing Deepgram after disconnect for {conversation_id}: {e}", exc_info=True)
    except Exception as e:
        logging.error(f"Unhandled error in STT WebSocket endpoint for {conversation_id}: {e}", exc_info=True)
    finally:
        if transcriber: 
            logging.info(f"Ensuring STT transcriber is finished in finally block for {conversation_id}.")
            try:
                await transcriber.finish()
                logging.info(f"Deepgram transcriber confirmed finished in finally block for {conversation_id}.")
            except Exception as e:
                logging.error(f"Error finishing Deepgram in finally block for {conversation_id}: {e}", exc_info=True)
        logging.info(f"STT WebSocket process complete for {conversation_id}.")

# NEW: HTTP Endpoint for Text Input (/api/chat/text) ---
class TextInput(BaseModel): # Requires pydantic
    text: str
    conversation_id: str 

@app.post("/api/chat/text")
async def chat_text_endpoint(text_input: TextInput):
    logging.info(f"Received text input: '{text_input.text}' for conversation: {text_input.conversation_id}")
    asyncio.create_task(process_text_for_ai(text_input.text, "text_input", text_input.conversation_id))
    return {"message": "Text received, processing initiated."}

# NEW: Endpoint to clear specific conversation history
@app.post("/api/clear_history")
async def clear_history_endpoint(conversation_id: str = Body(..., embed=True, min_length=1)):
    try:
        if redis_client.exists(f"chat_history:{conversation_id}"):
            redis_client.delete(f"chat_history:{conversation_id}")
            logging.info(f"Cleared conversation history for ID: {conversation_id} from Redis.")
            return {"message": f"History for {conversation_id} cleared."}
        return {"message": f"No history found for ID: {conversation_id}.", "status": "not_found"}
    except Exception as e:
        logging.error(f"Error clearing history for {conversation_id} from Redis: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to clear history: {e}")


# --- Middleware, Routers, and Health Check ---
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.include_router(chat_router, prefix="/api") # EXISTING, DO NOT CHANGE
app.include_router(voice_router, prefix="/api") # EXISTING, DO NOT CHANGE

@app.get("/")
async def health_check():
    try:
        redis_client.ping()
        redis_status = "Connected"
    except Exception:
        redis_status = "Disconnected"
    return {"status": "ok", "message": "AI Voice Assistant backend is running.", "redis_status": redis_status}