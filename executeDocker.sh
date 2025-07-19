# Load environment variables from .env file
set -a
source .env
set +a

# --- Use a unique version tag for the image ---
VERSION_TAG=$(date +%s)
IMAGE_NAME="conversational-ai-backend:${VERSION_TAG}"

docker stop ai-backend-container
docker rm ai-backend-container
docker build --no-cache -t "${IMAGE_NAME}" .

# Replace your old docker run command with this one
docker run -d -p 8000:8000 -e STT_PROVIDER="${STT_PROVIDER}" -e LLM_PROVIDER="${LLM_PROVIDER}" -e TTS_PROVIDER="${TTS_PROVIDER}" -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY}" -e GOOGLE_API_KEY="${GOOGLE_API_KEY}" -e OPENAI_API_KEY="${OPENAI_API_KEY}" -e ELEVENLABS_API_KEY="${ELEVENLABS_API_KEY}" -e ELEVENLABS_VOICE_ID="${ELEVENLABS_VOICE_ID}" -e LIVEKIT_API_KEY_SERVER="${LIVEKIT_API_KEY_SERVER}" -e LIVEKIT_API_SECRET_SERVER="${LIVEKIT_API_SECRET_SERVER}" --name ai-backend-container "${IMAGE_NAME}"

docker logs -f ai-backend-container
