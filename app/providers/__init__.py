# app/providers/__init__.py
from abc import ABC, abstractmethod
from typing import AsyncIterator

class STTProvider(ABC):
    @abstractmethod
    def get_transcriber(self, options):
        pass

class LLMProvider(ABC):
    @abstractmethod
    async def generate_response(self, transcript: str) -> str:
        pass

class TTSProvider(ABC):
    @abstractmethod
    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        """
        Synthesizes text into audio and yields audio chunks asynchronously.
        """
        pass

class TelephonyProvider(ABC):
    pass