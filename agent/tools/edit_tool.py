"""Edit Tool - replace text in file."""

from typing import Dict, Any

from agent.tools.base_tool import BaseTool
from agent.core.sandbox import SandboxViolation, resolve_path_for_tool


class EditTool(BaseTool):
    @property
    def name(self) -> str:
        return "edit"

    def get_tool_definition(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "edit",
                "description": "Replace one or all matches in a text file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "Path to the target file"},
                        "old_string": {"type": "string", "description": "Text to be replaced"},
                        "new_string": {"type": "string", "description": "Replacement text"},
                        "replace_all": {
                            "type": "boolean",
                            "description": "Replace all matches when true",
                            "default": False,
                        },
                    },
                    "required": ["file_path", "old_string", "new_string"],
                },
            },
        }

    def execute(self, **kwargs) -> Dict[str, Any]:
        file_path = kwargs.get("file_path")
        old_string = kwargs.get("old_string", "")
        new_string = kwargs.get("new_string", "")
        replace_all = kwargs.get("replace_all", False)

        try:
            path = resolve_path_for_tool(
                self,
                raw_path=file_path,
                for_write=True,
                must_exist=True,
                allow_directory=False,
            )

            try:
                content = path.read_text(encoding="utf-8")
                encoding = "utf-8"
            except UnicodeDecodeError:
                try:
                    content = path.read_text(encoding="gbk")
                    encoding = "gbk"
                except Exception:
                    return {"success": False, "error": "Cannot decode file (tried utf-8 and gbk)"}
            except PermissionError:
                return {"success": False, "error": f"Permission denied: {file_path}"}

            if old_string not in content:
                snippet = old_string[:50] + ("..." if len(old_string) > 50 else "")
                return {"success": False, "error": f"String not found in file: '{snippet}'"}

            match_count = content.count(old_string)
            if not replace_all and match_count > 1:
                return {
                    "success": False,
                    "error": (
                        f"String appears {match_count} times in file (not unique). "
                        "Use replace_all=true to replace all occurrences."
                    ),
                }

            if replace_all:
                new_content = content.replace(old_string, new_string)
                replacements = match_count
            else:
                new_content = content.replace(old_string, new_string, 1)
                replacements = 1

            try:
                path.write_text(new_content, encoding=encoding)
            except PermissionError:
                return {"success": False, "error": f"Permission denied when writing: {file_path}"}

            return {
                "success": True,
                "replacements": replacements,
                "message": f"Replaced {replacements} occurrence(s) in {file_path}",
                "details": {
                    "file_path": str(path),
                    "old_length": len(content),
                    "new_length": len(new_content),
                    "diff": len(new_content) - len(content),
                },
            }

        except SandboxViolation as e:
            return {"success": False, "error": f"Sandbox violation: {str(e)}"}
        except Exception as e:
            return {"success": False, "error": f"Unexpected error: {str(e)}"}


if __name__ == "__main__":
    tool = EditTool()
    print(tool.execute(file_path=__file__, old_string="Edit Tool", new_string="Edit Tool"))