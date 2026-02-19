"""
BaseTool - 


 ToolLoader  tool.execute(**kwargs)

"""

from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseTool(ABC):
    """"""

    @property
    @abstractmethod
    def name(self) -> str:
        """ tool_definition  name """
        pass

    @abstractmethod
    def get_tool_definition(self) -> Dict[str, Any]:
        """ OpenAI function calling """
        pass

    @abstractmethod
    def execute(self, **kwargs) -> Any:
        """
        

         **kwargs 
         ToolLoader  tool.execute(**arguments)
        """
        pass
