# app/providers/llm/google.py
import os
import logging
from .. import LLMProvider # Assuming this is your base abstract class

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain.prompts import ChatPromptTemplate, MessagesPlaceholder # NEW: Import MessagesPlaceholder
from langchain_core.output_parsers import StrOutputParser
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage # NEW: Import BaseMessage types

logging.basicConfig(level=logging.INFO) # Ensure logging is configured for this module

class GoogleLLMProvider(LLMProvider):
    def __init__(self):
        self.llm = ChatGoogleGenerativeAI(
            model="gemini-1.5-flash",
            google_api_key=os.getenv("GOOGLE_API_KEY"),
            # You might want to add other parameters here, like temperature
            temperature=0.7, 
            # You can also set convert_system_message_to_human=True if your backend
            # sends a SystemMessage as the very first message. Gemini often prefers user/model turns.
            # However, with MessagesPlaceholder, LangChain generally handles this conversion.
        )
        
        # MODIFIED: Prompt template to include chat history
        self.prompt = ChatPromptTemplate.from_messages([
            ("system", "You are a helpful AI assistant. You answer questions concisely."),
            # MessagesPlaceholder will inject the list of BaseMessage objects here
            MessagesPlaceholder(variable_name="chat_history"), # This variable name must match the input to the chain
            ("user", "{input}") # This is for the current user input
        ])
        
        # MODIFIED: The chain now expects both 'chat_history' and 'input'
        self.chain = self.prompt | self.llm | StrOutputParser()

    # MODIFIED: Method now accepts a list of BaseMessage
    async def generate_response(self, messages: list[BaseMessage]) -> str:
        """
        Generates a response from Google Gemini given a list of LangChain BaseMessage objects.
        The last message in the list is assumed to be the current user input.
        The rest of the list is considered chat history.
        """
        if not messages:
            return "No input received."
        
        # Separate the current user input from the chat history
        current_user_input = messages[-1].content # Last message is current user input
        chat_history = messages[:-1]              # All messages before the last one are history

        logging.info(f"GoogleLLMProvider: Current user input: '{current_user_input}'")
        logging.info(f"GoogleLLMProvider: Chat history length: {len(chat_history)}")
        # logging.debug(f"GoogleLLMProvider: Chat history content: {chat_history}") # Uncomment for detailed history logging

        try:
            # Invoke the chain with the separated chat history and current input
            response = await self.chain.ainvoke({
                "input": current_user_input,
                "chat_history": chat_history # Pass the list of BaseMessage objects as chat_history
            })
            return response
        except Exception as e:
            logging.error(f"Error calling Google Gemini API: {e}", exc_info=True)
            return "I'm sorry, I couldn't get a response from the AI right now."