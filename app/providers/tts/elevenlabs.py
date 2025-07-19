import os
from typing import AsyncIterator, List

from elevenlabs.client import AsyncElevenLabs
from elevenlabs import Voice, VoiceSettings

from .. import TTSProvider # Corrected relative import

# --- More Robust MP3 Frame Parsing Helper ---
# This version attempts to read MP3 frame header for accurate frame length.
# Based on common MPEG-1 Layer III (used by most MP3s like ElevenLabs output)
def get_mp3_frame_info(buffer: bytes, offset: int = 0) -> dict | None:
    """
    Parses an MP3 frame header to get its length.
    Returns {length: int, sample_rate: int, bitrate: int} or None if no valid frame header at offset.
    Supports MPEG-1 Layer III (most common MP3).
    """
    if len(buffer) < offset + 4: # Need at least 4 bytes for the header
        return None

    # Check for sync word (11 bits set)
    # 0xFFF (all ones) for first 11 bits
    if not (buffer[offset] == 0xFF and (buffer[offset+1] & 0xE0) == 0xE0):
        return None # Not an MP3 frame sync word

    header = int.from_bytes(buffer[offset:offset+4], byteorder='big')

    # MPEG Version (bits 19-20 of header, 00=2.5, 01=Reserved, 10=MPEG-2, 11=MPEG-1)
    mpeg_version_bits = (header >> 19) & 0b11
    if mpeg_version_bits != 0b11: # We are primarily interested in MPEG-1
        return None # Not MPEG-1 (or reserved)

    # Layer (bits 17-18 of header, 00=Reserved, 01=Layer III, 10=Layer II, 11=Layer I)
    layer_bits = (header >> 17) & 0b11
    if layer_bits != 0b01: # We are primarily interested in Layer III
        return None # Not Layer III (or reserved)

    # Bitrate index (bits 12-15) & Sample rate index (bits 10-11)
    bitrate_index = (header >> 12) & 0b1111
    sample_rate_index = (header >> 10) & 0b11

    # Padding bit (bit 9)
    padding_bit = (header >> 9) & 0b1

    # Bitrate table (kbps) for MPEG-1 Layer III
    bitrates = {
        0: 0, # free
        1: 32, 2: 40, 3: 48, 4: 56, 5: 64,
        6: 80, 7: 96, 8: 112, 9: 128, 10: 160,
        11: 192, 12: 224, 13: 256, 14: 320, 15: 0 # bad
    }
    bitrate = bitrates.get(bitrate_index)
    if bitrate is None or bitrate == 0:
        return None # Invalid bitrate

    # Sample rate table (Hz) for MPEG-1
    sample_rates = {
        0: 44100, 1: 48000, 2: 32000, 3: 0 # reserved
    }
    sample_rate = sample_rates.get(sample_rate_index)
    if sample_rate is None or sample_rate == 0:
        return None # Invalid sample rate

    # Frame length calculation for MPEG-1 Layer III (with padding)
    # (144 * bitrate / sample_rate) + padding
    frame_length = int((144 * bitrate * 1000) / sample_rate) + padding_bit

    return {
        "length": frame_length,
        "sample_rate": sample_rate,
        "bitrate": bitrate
    }


async def mp3_frame_streamer(audio_chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """
    Buffers incoming raw audio bytes and yields only complete and valid MP3 frames.
    """
    buffer = b""
    async for chunk in audio_chunks:
        buffer += chunk
        offset = 0
        while True:
            frame_info = get_mp3_frame_info(buffer, offset)
            if frame_info:
                frame_length = frame_info["length"]
                # Ensure the entire frame is in the buffer
                if offset + frame_length <= len(buffer):
                    frame = buffer[offset:offset+frame_length]
                    yield frame
                    offset += frame_length # Move offset past the yielded frame
                else:
                    # Not enough data for this frame, wait for more chunks
                    break
            else:
                # No valid MP3 frame header at current offset, or not enough header bytes
                # Scan for next potential sync word
                # This helps skip over bad data or non-frame data (e.g., ID3 tags)
                # It's a heuristic, a robust parser would manage this more strictly.
                next_sync_word_offset = buffer.find(b'\xFF', offset + 1)
                if next_sync_word_offset != -1:
                    offset = next_sync_word_offset
                else:
                    break # No more potential sync words in this buffer, wait for more chunks
        
        # Remove consumed frames from the buffer
        buffer = buffer[offset:]

    # After loop, if any buffer remains, it's either an incomplete frame or trailing data.
    # Yield it as a final chunk. MediaSource is typically tolerant of the very last partial frame.
    if buffer:
        print(f"Warning: mp3_frame_streamer yielding final potentially incomplete buffer of {len(buffer)} bytes.")
        yield buffer
# --- End More Robust MP3 Frame Parsing Helper ---


class ElevenLabsTTSProvider(TTSProvider):
    def __init__(self):
        self.api_key = os.getenv("ELEVENLABS_API_KEY")
        if not self.api_key:
            raise ValueError("ELEVENLABS_API_KEY environment variable not set.")

        self.client = AsyncElevenLabs(api_key=self.api_key)
        self.default_voice_id = os.getenv("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        try:
            raw_audio_stream: AsyncIterator[bytes] = self.client.text_to_speech.stream(
                text=text,
                voice_id=self.default_voice_id,
                model_id="eleven_multilingual_v2",
                output_format="mp3_44100_128"
            )
            # --- Pipe raw stream through MP3 frame parser ---
            async for frame in mp3_frame_streamer(raw_audio_stream):
                yield frame
        except Exception as e:
            print(f"Error synthesizing with Eleven Labs: {e}")
            raise

    async def get_available_voices(self) -> list:
        try:
            voices_response = await self.client.voices.get_all()
            voices_list = []
            for voice in voices_response.voices:
                voices_list.append({
                    "id": voice.voice_id,
                    "name": voice.name,
                    "category": voice.category,
                    "description": getattr(voice, 'description', ''),
                })
            return voices_list
        except Exception as e:
            print(f"Error fetching Eleven Labs voices: {e}")
            raise


# Example of how you might use it (for standalone testing)
if __name__ == "__main__":
    import asyncio
    import sys
    from .. import TTSProvider # Assuming it's run as part of the package

    async def run_elevenlabs_test():
        os.environ["ELEVENLABS_API_KEY"] = os.getenv("ELEVENLABS_API_KEY", "YOUR_ELEVEN_LABS_API_KEY_HERE")
        os.environ["ELEVENLABS_VOICE_ID"] = os.getenv("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

        print("--- ElevenLabsTTSProvider Test (Standalone) ---")
        try:
            provider = ElevenLabsTTSProvider()
            print("ElevenLabsTTSProvider initialized successfully.")

            print("\n2. Testing audio synthesis...")
            test_text = "This is a test of the Eleven Labs Text-to-Speech provider with robust backend MP3 frame parsing. This should lead to much smoother audio playback."
            print(f"Synthesizing: '{test_text}' using voice '{provider.default_voice_id}'")
            try:
                full_audio_data = b""
                frame_count = 0
                async for chunk in provider.synthesize(test_text):
                    frame_count += 1
                    full_audio_data += chunk
                    # print(f"Received frame {frame_count}: {len(chunk)} bytes") # Uncomment for verbose frame logging
                print(f"Successfully synthesized {len(full_audio_data)} bytes of audio across {frame_count} frames.")

                output_filename = "elevenlabs_test_standalone_framed_output.mp3"
                with open(output_filename, "wb") as f:
                    f.write(full_audio_data)
                print(f"Audio saved to '{output_filename}'. Please check the quality by playing this file directly.")

            except Exception as e:
                print(f"Error during audio synthesis: {e}", file=sys.stderr)

        except (ValueError, RuntimeError) as e:
            print(f"Initialization/Setup Error: {e}", file=sys.stderr)
        except Exception as e:
            print(f"An unexpected error occurred during test: {e}", file=sys.stderr)
        print("\n--- Test Complete ---")

    asyncio.run(run_elevenlabs_test())