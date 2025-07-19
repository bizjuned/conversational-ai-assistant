# app/providers/llm/google.py
import os
from .. import LLMProvider
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

class GoogleLLMProvider(LLMProvider):
    def __init__(self):
        self.llm = ChatGoogleGenerativeAI(
            model="gemini-1.5-flash",
            google_api_key=os.getenv("GOOGLE_API_KEY"),
        )
        self.prompt = ChatPromptTemplate.from_messages([
            ("system", "You are a helpful AI assistant. You answer questions concisely."),
            ("user", "{input}")
        ])
        self.chain = self.prompt | self.llm | StrOutputParser()

    async def generate_response(self, transcript: str) -> str:
        return await self.chain.ainvoke({"input": transcript})