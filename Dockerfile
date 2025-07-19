# conversational-ai-assistant/Dockerfile

# Use a lightweight Python base image
FROM python:3.12-slim-bookworm

# Set the working directory inside the container
WORKDIR /app

# Copy the requirements file and install dependencies first
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt # This will now install deepgram-sdk

# Copy the rest of your application code into the container
COPY app/ app/

# Copy the .env.example as a reference (we'll pass actual vars at runtime)
COPY .env.example .

# Expose the port that FastAPI will run on
EXPOSE 8000

# Command to run the FastAPI application using Uvicorn
CMD ["uvicorn", "app.core.main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "debug"]