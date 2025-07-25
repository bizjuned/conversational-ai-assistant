import os
import logging
from typing import Any

# LangChain Vectorstore types - import relevant ones
from langchain.vectorstores import Chroma # For local/development
from langchain_community.vectorstores import PGVector # For PostgreSQL (pgvector)
# from langchain_pinecone import Pinecone as LangChainPinecone # For Pinecone (uncomment when implemented)
# from langchain_weaviate import WeaviateVectorStore # For Weaviate (uncomment when implemented)

# Embedding provider (assumed to be Google for this project)
from langchain_google_genai import GoogleGenerativeAIEmbeddings

# Specific connectors (we'll implement pgvector_connector.py next)
from app.db.pgvector_connector import get_pgvector_store # This will be created in the next step
# from app.db.pinecone_connector import get_pinecone_store # Uncomment when implemented
# from app.db.weaviate_connector import get_weaviate_store # Uncomment when implemented

logging.basicConfig(level=logging.INFO)

# Global embedding instance to ensure it's initialized only once
_embeddings = None

def get_embeddings() -> GoogleGenerativeAIEmbeddings:
    """Initializes and returns a Google Generative AI Embeddings model."""
    global _embeddings
    if _embeddings is None:
        _embeddings = GoogleGenerativeAIEmbeddings(
            model="models/embedding-001", # Standard Google embedding model
            google_api_key=os.getenv("GOOGLE_API_KEY")
        )
        if not os.getenv("GOOGLE_API_KEY"):
            logging.warning("GOOGLE_API_KEY not set. Embeddings will not work for vector DB. Please set it in your .env file.")
    return _embeddings

def get_vector_store() -> Any: # Returns a LangChain VectorStore object
    """
    Returns an initialized LangChain vector store instance based on the VECTOR_DB_PROVIDER
    environment variable.
    """
    # Default to 'pgvector' as it's our primary integration for now
    vector_db_provider = os.getenv("VECTOR_DB_PROVIDER", "pgvector").lower()
    logging.info(f"Attempting to initialize Vector DB Provider: {vector_db_provider}")

    embeddings = get_embeddings() # Get the global embeddings instance

    if vector_db_provider == "pgvector":
        return get_pgvector_store(embeddings)
    elif vector_db_provider == "pinecone":
        logging.error("Pinecone connector is not yet implemented.")
        raise NotImplementedError("Pinecone vector DB connector not yet implemented.")
    elif vector_db_provider == "weaviate":
        logging.error("Weaviate connector is not yet implemented.")
        raise NotImplementedError("Weaviate vector DB connector not yet implemented.")
    elif vector_db_provider == "chroma": # Keep Chroma as a simple local/dev fallback
        persist_directory = "./chroma_db" # This path will be relative to /app inside Docker
        logging.info(f"Initializing ChromaDB (local persistence to {persist_directory})")
        return Chroma(embedding_function=embeddings, persist_directory=persist_directory)
    else:
        logging.error(f"Unknown VECTOR_DB_PROVIDER: '{vector_db_provider}'. Please set it correctly in your .env file.")
        raise ValueError(f"Unknown VECTOR_DB_PROVIDER: '{vector_db_provider}'")