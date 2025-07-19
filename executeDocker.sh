#!/usr/bin/env bash
# OR #!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# Load environment variables from .env file
# This assumes your .env file is in the same directory as this script.
set -a
source .env
set +a

# --- Docker Network Setup ---
echo "Checking for Docker network 'ai-assistant-network'..."
docker network inspect ai-assistant-network >/dev/null 2>&1 || \
    (echo "Network 'ai-assistant-network' not found, creating it..." && docker network create ai-assistant-network)
echo "Docker network 'ai-assistant-network' is ready."

# --- Run Redis Container ---
echo "Checking for Redis container 'my-redis-db'..."
if [ "$(docker ps -q -f name=my-redis-db)" ]; then
    echo "Redis container 'my-redis-db' is already running."
elif [ "$(docker ps -aq -f name=my-redis-db)" ]; then
    echo "Redis container 'my-redis-db' exists but is stopped. Starting it..."
    docker start my-redis-db
else
    echo "Redis container 'my-redis-db' not found. Creating and starting it..."
    docker run --name my-redis-db \
      --network ai-assistant-network \
      -p 6379:6379 \
      -d redis:7-alpine
fi
echo "Redis container 'my-redis-db' is ready."


# --- Backend Container Management ---

# --- Use a unique version tag for the image ---
VERSION_TAG=$(date +%s)
IMAGE_NAME="conversational-ai-backend:${VERSION_TAG}"

echo "Stopping and removing existing backend container (if any)..."
docker stop ai-backend-container >/dev/null 2>&1 || true
docker rm ai-backend-container >/dev/null 2>&1 || true
echo "Existing backend container removed."

echo "Building Docker image: ${IMAGE_NAME}..."
docker build -t "${IMAGE_NAME}" .
echo "Image built successfully."

echo "Running Docker container: ai-backend-container..."

# Initialize an empty array for environment arguments
declare -a ENV_ARGS_FOR_DOCKER_RUN=()

# Function to safely add an environment variable as a "-e KEY=VALUE" argument pair
add_env_arg_to_docker() {
  local key="$1"
  local value="$2"
  # Check if the value is not empty
  if [ -n "$value" ]; then
    ENV_ARGS_FOR_DOCKER_RUN+=("-e")
    ENV_ARGS_FOR_DOCKER_RUN+=("${key}=${value}")
  fi
}

# --- Add all your environment variables safely ---
add_env_arg_to_docker "REDIS_HOST" "my-redis-db"
add_env_arg_to_docker "REDIS_PORT" "6379"

add_env_arg_to_docker "STT_PROVIDER" "${STT_PROVIDER}"
add_env_arg_to_docker "LLM_PROVIDER" "${LLM_PROVIDER}"
add_env_arg_to_docker "TTS_PROVIDER" "${TTS_PROVIDER}"
add_env_arg_to_docker "DEEPGRAM_API_KEY" "${DEEPGRAM_API_KEY}"
add_env_arg_to_docker "GOOGLE_API_KEY" "${GOOGLE_API_KEY}"
add_env_arg_to_docker "OPENAI_API_KEY" "${OPENAI_API_KEY}"
add_env_arg_to_docker "ELEVENLABS_API_KEY" "${ELEVENLABS_API_KEY}"
add_env_arg_to_docker "ELEVENLABS_VOICE_ID" "${ELEVENLABS_VOICE_ID}"
add_env_arg_to_docker "LIVEKIT_API_KEY_SERVER" "${LIVEKIT_API_KEY_SERVER}"
add_env_arg_to_docker "LIVEKIT_API_SECRET_SERVER" "${LIVEKIT_API_SECRET_SERVER}" 

add_env_arg_to_docker "GOOGLE_GEMINI_MODEL_NAME" "${GOOGLE_GEMINI_MODEL_NAME}"
add_env_arg_to_docker "OPENAI_MODEL_NAME" "${OPENAI_MODEL_NAME}"


# --- DEBUGGING STEP (NEW!) ---
echo "DEBUGGING: Environment arguments to be passed to docker run:"
printf '%s\n' "${ENV_ARGS_FOR_DOCKER_RUN[@]}"
echo "--- END DEBUGGING ---"


# Execute the docker run command with the safely constructed environment arguments
docker run -d \
  --network ai-assistant-network \
  -p 8000:8000 \
  "${ENV_ARGS_FOR_DOCKER_RUN[@]}" \
  --name ai-backend-container "${IMAGE_NAME}"
echo "Backend container started."

echo "Attaching to logs of ai-backend-container..."
docker logs -f ai-backend-container
