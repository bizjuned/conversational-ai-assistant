# app/core/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os

# --- LangChain Imports (Updated for Google Gemini) ---
from langchain_google_genai import ChatGoogleGenerativeAI 
from langchain.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

# --- API Router Imports ---
# We import the chat API router from the api/chat.py file.
from app.api.chat import router as chat_router

# Load environment variables from .env file
load_dotenv() 

# Initialize FastAPI
app = FastAPI(
    title="Conversational AI Assistant API",
    description="A stream-based backend for chat and voice AI.",
    version="0.1.0",
)

# Configure CORS (essential for embedding the frontend widgets)
origins = ["*"] 
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- LLM and LangChain Setup (Updated to Google Gemini) ---

# Retrieve Google API key securely from environment variables.
google_api_key = os.getenv("GOOGLE_API_KEY")

if not google_api_key:
    # Handle missing API key gracefully
    print("Warning: GOOGLE_API_KEY not set. LLM will not function.")
    llm = None
else:
    # Initialize the LLM using ChatGoogleGenerativeAI.
    # We use 'gemini-1.5-flash' for fast, low-latency responses suitable for streaming.
    llm = ChatGoogleGenerativeAI(
        model="gemini-1.5-flash",
        google_api_key=google_api_key,
    )

# Define the prompt template
prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a helpful AI assistant. You answer questions concisely."),
    ("user", "{input}")
])

# Create the LangChain Runnable (LCEL): Prompt -> LLM -> Output Parser
if llm:
    chain = prompt | llm | StrOutputParser()
else:
    chain = None # The chain will be None if the LLM key is missing

# --- API Router Integration ---

# Include the chat router in the FastAPI app with a prefix of '/api'
app.include_router(chat_router, prefix="/api")

# --- Endpoints ---

@app.get("/")
async def health_check():
    """Basic health check endpoint."""
    return {"status": "ok", "message": "API is operational"}