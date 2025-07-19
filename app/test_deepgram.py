# test_deepgram.py
import os
import asyncio
import logging
from deepgram import DeepgramClient, LiveTranscriptionEvents, LiveOptions

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Load Deepgram API Key from environment variable
from dotenv import load_dotenv
load_dotenv()
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")

async def test_deepgram_connection():
    if not DEEPGRAM_API_KEY:
        logging.error("DEEPGRAM_API_KEY environment variable not set. Cannot test Deepgram.")
        return

    logging.info("Starting Deepgram connection test.")
    deepgram_transcriber = None
    try:
        deepgram_client = DeepgramClient(DEEPGRAM_API_KEY)
        logging.info("DeepgramClient initialized for test.")

        # Use v("1") for the latest real-time API
        deepgram_transcriber = deepgram_client.listen.asynclive.v("1") 
        logging.info("Deepgram transcriber instance created for test.")

        options = LiveOptions(
            model="nova-2", 
            punctuate=True, 
            language="en-US",
            encoding="linear16", # Use a common encoding for test, even if not sending audio
            sample_rate=16000 # Use a common sample rate for test
        )
        logging.info(f"Deepgram options configured for test: {options.to_dict()}")

        # Register just a simple error handler for the test
        async def on_error(self, error):
            logging.error(f"Deepgram Error in Test: {error}")
        deepgram_transcriber.on(LiveTranscriptionEvents.Error, on_error)

        logging.info("Attempting to connect to Deepgram Realtime API for test.")
        await deepgram_transcriber.start(options)
        logging.info("SUCCESS: Connected to Deepgram Realtime Transcriber for test.")

        # Keep connection alive briefly to see if it immediately closes or errors
        await asyncio.sleep(5) 

    except Exception as e:
        logging.exception(f"Deepgram Test FAILED unexpectedly: {e}")
    finally:
        if deepgram_transcriber:
            await deepgram_transcriber.finish()
            logging.info("Deepgram Realtime Transcriber finished test.")
        logging.info("Deepgram test complete.")

if __name__ == "__main__":
    asyncio.run(test_deepgram_connection())