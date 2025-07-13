# app/api/chat.py
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from typing import AsyncGenerator

router = APIRouter()

@router.post("/chat/stream")
async def chat_stream(request: dict):
    """
    Endpoint for streaming chat responses from the LLM.
    """
    # We import 'chain' here to ensure the LLM has been initialized in main.py
    from app.core.main import chain 

    user_input = request.get("input")

    if not user_input or not chain:
        return {"error": "Input message or LLM chain is missing."}

    # Asynchronous generator to stream the output
    async def stream_generator(input_text: str) -> AsyncGenerator[str, None]:
        # Use LangChain's astream() to get an async iterator over the tokens
        async for chunk in chain.astream({"input": input_text}):
            # Yield each token chunk immediately as it's generated
            yield chunk

    # Return a StreamingResponse using text/event-stream
    return StreamingResponse(stream_generator(user_input), media_type="text/event-stream")