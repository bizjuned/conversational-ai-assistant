import os
import logging
from typing import Any

from langchain_community.vectorstores import PGVector
from langchain_google_genai import GoogleGenerativeAIEmbeddings # Used for type hinting

logging.basicConfig(level=logging.INFO)

def get_pgvector_store(embeddings: GoogleGenerativeAIEmbeddings) -> PGVector:
    """
    Initializes and returns a LangChain PGVector store instance.
    It expects PostgreSQL connection details from environment variables.
    The table (collection) will be created automatically if it doesn't exist.
    """
    # Get PostgreSQL connection details from environment variables
    PG_HOST = os.getenv("PG_HOST", "localhost")
    PG_PORT = os.getenv("PG_PORT", "5432")
    PG_DB = os.getenv("PG_DB", "rag_db")
    PG_USER = os.getenv("PG_USER", "user")
    PG_PASSWORD = os.getenv("PG_PASSWORD", "password")
    COLLECTION_NAME = os.getenv("PG_COLLECTION_NAME", "rag_collection") # This will be the table name in Postgres

    # Construct the connection string for psycopg2 (the PostgreSQL adapter)
    CONNECTION_STRING = PGVector.connection_string_from_db_params(
        driver="psycopg2", # This specifies the driver, requiring psycopg2-binary to be installed
        host=PG_HOST,
        port=PG_PORT,
        database=PG_DB,
        user=PG_USER,
        password=PG_PASSWORD,
    )
    
    logging.info(f"Attempting to connect to PGVector: {PG_USER}@{PG_HOST}:{PG_PORT}/{PG_DB} (Collection: {COLLECTION_NAME})")

    try:
        # Initialize the PGVector store.
        # LangChain's PGVector will automatically create the table for the collection
        # if it doesn't already exist in the specified database.
        store = PGVector(
            collection_name=COLLECTION_NAME,
            connection_string=CONNECTION_STRING,
            embedding_function=embeddings,
            # Other optional parameters can be added here, e.g., distance strategy
            # distance_strategy=DistanceStrategy.COSINE # Requires from langchain_community.vectorstores.pgvector
        )
        logging.info("PGVector store initialized successfully.")
        return store
    except Exception as e:
        logging.error(f"Failed to initialize PGVector store: {e}", exc_info=True)
        logging.error(f"Please ensure PostgreSQL is running, pgvector extension is enabled, and connection details (PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD) are correct in your .env file and docker-compose.yml.")
        raise RuntimeError("Failed to connect to PGVector database.") from e