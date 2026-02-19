from openai import OpenAI
from typing import List, Dict, Any, Optional

from agent.core.config import LLM_MAX_TOKENS, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_NAME


class LLMClient:
    def __init__(
        self,
        model_name: str = None,
        base_url: str = None,
        api_key: str = None
    ):
        """
         LLM 

         >  > config.py
        """
        # 
        if not (base_url and api_key and model_name):
            try:
                from agent.core.config import get_llm_config
                db_config = get_llm_config()
                if db_config:
                    base_url = base_url or db_config["base_url"]
                    api_key = api_key or db_config["api_key"]
                    model_name = model_name or db_config["model_name"]
            except Exception:
                pass

        #  fallback 
        self.client = OpenAI(
            base_url=base_url or LLM_BASE_URL,
            api_key=api_key or LLM_API_KEY
        )
        self.model_name = model_name or LLM_MODEL_NAME

    def generate(self, prompt: str, max_tokens: int = LLM_MAX_TOKENS) -> str:
        """
        

        Args:
            prompt: 
            max_tokens: token

        Returns:
            
        """
        completion = self.client.chat.completions.create(
            model=self.model_name,
            messages=[
                {"role": "user", "content": prompt}
            ],
            max_tokens=max_tokens,
        )
        # 
        if not completion.choices:
            return ""
        return completion.choices[0].message.content or ""

    def generate_with_tools(
        self,
        messages: List[Dict[str, str]],
        tools: Optional[List[Dict[str, Any]]] = None,
        max_tokens: int = LLM_MAX_TOKENS,
        stream: bool = False
    ) -> Any:
        """
         function calling

        Args:
            messages: 
            tools: OpenAI format
            max_tokens:  token 
            stream: 

        Returns:
            stream=False: OpenAI 
            stream=True: yield chunk 
        """
        kwargs = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": stream,
        }

        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        response = self.client.chat.completions.create(**kwargs)

        # 
        if not stream:
            return response

        # 
        return self._stream_generator(response)

    def _stream_generator(self, response):
        """
         OpenAI stream 

        Yields:
            dict: {
                "type": "content" | "reasoning" | "tool_call" | "done",
                "data": str | dict
            }
        """
        for chunk in response:
            if not chunk.choices:
                continue

            delta = chunk.choices[0].delta

            # 1. reasoning
            if hasattr(delta, 'reasoning_details') and delta.reasoning_details:
                yield {
                    "type": "reasoning",
                    "data": delta.reasoning_details
                }
            # MiniMax  reasoning_content 
            elif hasattr(delta, 'reasoning_content') and delta.reasoning_content:
                yield {
                    "type": "reasoning",
                    "data": delta.reasoning_content
                }

            # 2. content
            if delta.content:
                yield {
                    "type": "content",
                    "data": delta.content
                }

            # 3. tool_calls
            if hasattr(delta, 'tool_calls') and delta.tool_calls:
                for tool_call in delta.tool_calls:
                    yield {
                        "type": "tool_call",
                        "data": {
                            "index": getattr(tool_call, 'index', None),
                            "id": getattr(tool_call, 'id', None),
                            "name": tool_call.function.name if hasattr(tool_call, 'function') else None,
                            "arguments": tool_call.function.arguments if hasattr(tool_call, 'function') else None,
                        }
                    }

            # 4. 
            if chunk.choices[0].finish_reason:
                yield {
                    "type": "done",
                    "data": chunk.choices[0].finish_reason
                }
                break
