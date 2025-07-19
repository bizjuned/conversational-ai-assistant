# app/providers/stt/deepgram.py
import os
from .. import STTProvider
from deepgram import DeepgramClient

class DeepgramSTTProvider(STTProvider):
    def __init__(self):
        self.client = DeepgramClient(os.getenv("DEEPGRAM_API_KEY"))
    
    def get_transcriber(self, options):
        return self.client.listen.asynclive.v("1")