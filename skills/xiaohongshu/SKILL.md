---
name: xiaohongshu
description: MANDATORY ROUTING: For any request about 小红书/红书/薯/XHS/Rednote/xiaohongshu (search, note reading, user profile, comments, trends, browsing), always call skill__xiaohongshu first; do NOT call tool_search first. Use this skill to provide the exact rednote workflow, then run tool_search only when the workflow requires loading rednote MCP tools.
---

# Xiaohongshu Browsing Skill

Use this skill when the user asks for Xiaohongshu search, note reading, profile analysis, comments, or trend mining.

## Mandatory First Steps

Because `rednote` is configured as a `searchable` MCP server, you must load it first.

For every new Xiaohongshu task, do this in order:

1. `tool_search(query="xiaohongshu rednote")`
2. `mcp__rednote__login()`

Rules:
- Always call `tool_search(...)` before any `mcp__rednote__*` call.
- Always run `login()` before `search`, `browse`, `click`, `scroll`, or `snapshot`.
- `login()` must open an interactive browser window for QR scan.
- If login times out or fails, call `login()` again and explain what the user should do.

## Available rednote Tools

- `search(keyword, type?)`: search notes (`type="note"`) or users (`type="user"`).
- `browse(url)`: navigate to a URL.
- `click(target)`: click by visible text, URL fragment, noteId, or coordinates.
- `scroll(direction?, amount?)`: scroll page content.
- `snapshot()`: get a structured page snapshot.
- `go_back()`: browser back navigation.
- `type_text(text, press_enter?)`: type into focused input.
- `press_key(key)`: keyboard actions.
- `login()`: interactive QR login and cookie refresh.

## Execution Policy

- Use tools sequentially (no parallel calls).
- Prefer `click()` over direct `browse()` for note entry, because dynamic anti-bot params are often added on click.
- If anti-bot or captcha appears, keep the user informed and retry after `login()`.

## Typical Workflow

1. `tool_search(query="xiaohongshu rednote")`
2. `login()`
3. `search(keyword)`
4. `click(target_note)`
5. `snapshot()` and extract findings
6. `go_back()` and continue sampling

For user profile analysis:

1. `tool_search(query="xiaohongshu rednote")`
2. `login()`
3. `search(username, type="user")`
4. `click(target_user)`
5. `snapshot()` and `scroll("down")`

