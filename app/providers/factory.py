# app/providers/factory.py
import os
from .stt.deepgram import DeepgramSTTProvider
from .llm.google import GoogleLLMProvider
from .llm.openai import OpenAILLMProvider
from .tts.elevenlabs import ElevenLabsTTSProvider

def get_stt_provider():
    provider = os.getenv("STT_PROVIDER", "DEEPGRAM").upper()
    if provider == "DEEPGRAM":
        return DeepgramSTTProvider()
    raise ValueError(f"Unsupported STT provider: {provider}")

def get_llm_provider():
    provider = os.getenv("LLM_PROVIDER", "GOOGLE").upper()
    if provider == "GOOGLE":
        return GoogleLLMProvider()
    elif provider == "OPENAI":
        return OpenAILLMProvider()
    raise ValueError(f"Unsupported LLM provider: {provider}")

def get_tts_provider():
    provider = os.getenv("TTS_PROVIDER", "ELEVENLABS").upper()
    if provider == "ELEVENLABS":
        return ElevenLabsTTSProvider()
    raise ValueError(f"Unsupported TTS provider: {provider}")