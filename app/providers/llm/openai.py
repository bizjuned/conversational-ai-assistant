# app/providers/llm/openai.py
import os
from .. import LLMProvider
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

class OpenAILLMProvider(LLMProvider):
    def __init__(self):
        self.llm = ChatOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.prompt = ChatPromptTemplate.from_messages([
            ("system", "You are a helpful AI assistant. You answer questions concisely."),
            ("user", "{input}")
        ])
        self.chain = self.prompt | self.llm | StrOutputParser()

    async def generate_response(self, transcript: str) -> str:
        return await self.chain.ainvoke({"input": transcript})