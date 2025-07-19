# /app/app/providers/tts/elevenlabs.py

import os
from typing import AsyncIterator, Optional, List, Dict, Any

# Correct import for the abstract base class
from .. import TTSProvider

try:
    from elevenlabs import Voice, VoiceSettings # These might not be strictly needed for synthesize, but for get_available_voices
    from elevenlabs.client import ElevenLabs, AsyncElevenLabs # Import AsyncElevenLabs for async calls
except ImportError:
    print(
        "Warning: 'elevenlabs' library not found. "
        "ElevenLabsTTSProvider will not be functional. "
        "Please install it with 'pip install elevenlabs'."
    )
    ElevenLabs = None
    AsyncElevenLabs = None
    Voice = None
    VoiceSettings = None

class ElevenLabsTTSProvider(TTSProvider):
    """
    Concrete implementation of TTSProvider using the Eleven Labs API.
    This version supports asynchronous streaming of audio chunks.
    """

    def __init__(self):
        if AsyncElevenLabs is None: # Check for the async client directly
            raise RuntimeError(
                "ElevenLabs library is not installed. "
                "Please install it with 'pip install elevenlabs'."
            )

        self.api_key: Optional[str] = os.getenv("ELEVENLABS_API_KEY")
        if not self.api_key:
            raise ValueError(
                "Eleven Labs API key not found. "
                "Please set the ELEVEN_LABS_API_KEY environment variable."
            )
        # Use the AsyncElevenLabs client for asynchronous operations
        self.client: AsyncElevenLabs = AsyncElevenLabs(api_key=self.api_key)

        self.default_voice_id: str = os.getenv("ELEVEN_LABS_DEFAULT_VOICE_ID", "EXAVITQu4vr4xnSDxMaL") # Rachel

    # This method now matches the updated abstract method signature, yielding chunks
    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        """
        Synthesizes text into audio using Eleven Labs and yields audio chunks asynchronously.

        Args:
            text (str): The text to synthesize.
            Note: voice_id cannot be passed here directly due to the abstract method signature.
                  It uses the default voice configured in the provider's initialization.

        Yields:
            bytes: Chunks of audio data.

        Raises:
            Exception: For any errors during the synthesis process from Eleven Labs API.
        """
        try:
            # Use client.text_to_speech.stream as per docs
            # It already returns an AsyncIterator[bytes] when stream=True (which is its default behavior)
            audio_stream: AsyncIterator[bytes] = self.client.text_to_speech.stream(
                text=text,
                voice_id=self.default_voice_id,
                # model_id="eleven_multilingual_v2", # Optional: specify model
                # output_format="mp3_44100_128" # Optional: specify format
            )

            async for chunk in audio_stream:
                if chunk:
                    yield chunk
        except Exception as e:
            print(f"Error synthesizing with Eleven Labs: {e}")
            raise

    async def get_available_voices(self) -> List[Dict[str, Any]]:
        """
        Retrieves a list of available voices from Eleven Labs using the async client.
        """
        if self.client.voices is None: # type: ignore
            raise RuntimeError("ElevenLabs voices client is not available.")

        try:
            voices_response = await self.client.voices.get_all()

            voices_list: List[Dict[str, Any]] = []
            for voice in voices_response.voices:
                voices_list.append({
                    "id": voice.voice_id,
                    "name": voice.name,
                    "category": voice.category,
                    "description": getattr(voice, 'description', ''),
                    "labels": getattr(voice, 'labels', {}),
                    "settings": getattr(voice, 'settings', None),
                })
            return voices_list
        except Exception as e:
            print(f"Error fetching Eleven Labs voices: {e}")
            raise


# Example of how you might use it (for standalone testing)
if __name__ == "__main__":
    import asyncio
    import sys
    from elevenlabs import stream as elevenlabs_stream_play # Alias to avoid name conflict with our 'stream' variable

    async def run_elevenlabs_test():
        os.environ["ELEVEN_LABS_API_KEY"] = os.getenv("ELEVEN_LABS_API_KEY", "YOUR_ELEVEN_LABS_API_KEY_HERE")
        os.environ["ELEVEN_LABS_DEFAULT_VOICE_ID"] = os.getenv("ELEVEN_LABS_DEFAULT_VOICE_ID", "EXAVITQu4vr4xnSDxMaL") # Bella

        print("--- ElevenLabsTTSProvider Test (Streaming Enabled) ---")
        try:
            provider = ElevenLabsTTSProvider()
            print("ElevenLabsTTSProvider initialized successfully.")

            # Test synthesizing audio (streaming)
            print("\n1. Testing audio synthesis (streaming)...")
            test_text = "Hello, this is a refined test of the Eleven Labs Text-to-Speech provider, now truly streaming."
            print(f"Synthesizing: '{test_text}' using default voice '{provider.default_voice_id}'")
            try:
                # The synthesize method now returns an async iterator
                audio_stream_iterator = provider.synthesize(test_text)

                print("Starting to stream audio...")
                # Option 1: Process chunks manually (e.g., send over WebSocket, save to file)
                # This will collect all chunks into memory for saving to a file.
                # In a real-time app, you'd send them as they arrive.
                full_audio_data = b""
                async for chunk in audio_stream_iterator:
                    if chunk:
                        full_audio_data += chunk
                        # print(f"Received chunk of size: {len(chunk)} bytes") # Uncomment to see chunks
                print(f"Finished receiving audio stream. Total bytes: {len(full_audio_data)}")

                output_filename = "elevenlabs_test_streaming_output.mp3"
                with open(output_filename, "wb") as f:
                    f.write(full_audio_data)
                print(f"Streamed audio saved to '{output_filename}'.")

                # Option 2: Use elevenlabs.stream utility for local playback (requires a fresh iterator)
                # If you want to play, you'd need to call synthesize again or ensure the iterator is reusable
                # Note: elevenlabs_stream_play(audio_stream_iterator) would only work if the iterator wasn't consumed
                # For this test, saving to file is enough to verify content.

            except Exception as e:
                print(f"Error during audio synthesis: {e}", file=sys.stderr)

        except (ValueError, RuntimeError) as e:
            print(f"Initialization/Setup Error: {e}", file=sys.stderr)
        except Exception as e:
            print(f"An unexpected error occurred during test: {e}", file=sys.stderr)
        print("\n--- Test Complete ---")

    asyncio.run(run_elevenlabs_test())