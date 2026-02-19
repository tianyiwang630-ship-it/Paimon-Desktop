---
name: xiaohongshu
description: Browse Xiaohongshu (Rednote/XHS) and extract notes, users, comments, and trend signals via the rednote MCP tools.
---

# Xiaohongshu Browsing Skill

Use this skill when the user asks for Xiaohongshu search, note reading, profile analysis, comments, or trend mining.

## Mandatory Activation for Searchable MCP

`rednote` is configured as a **searchable** MCP server, so its tools are hidden until discovered.

For every new task, do this sequence first:

1. Call `tool_search` with a query that includes `rednote` / `xiaohongshu` and the action you need.
2. Confirm the returned callable tool names (typically `mcp__rednote__...`).
3. Then call `mcp__rednote__login()` before any browsing/search action.

Recommended first search:

`tool_search(query="rednote xiaohongshu login search browse snapshot")`

If no rednote tools are returned, retry `tool_search` with a more specific query.

## Login Rules

- Always run `mcp__rednote__login()` before `search`, `browse`, `click`, `scroll`, or `snapshot`.
- `login()` should open an interactive browser window for QR scan when login is required.
- If login times out or fails, call `login()` again and explain the next user action.

## Typical rednote Tools

Use the exact names returned by `tool_search`.
Common actions:

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

1. `tool_search(...)` to expose rednote tools.
2. `mcp__rednote__login()`
3. `mcp__rednote__search(keyword)`
4. `mcp__rednote__click(target_note)`
5. `mcp__rednote__snapshot()` and extract findings.
6. `mcp__rednote__go_back()` and continue sampling.

For user profile analysis:

1. `tool_search(...)`
2. `mcp__rednote__login()`
3. `mcp__rednote__search(username, type="user")`
4. `mcp__rednote__click(target_user)`
5. `mcp__rednote__snapshot()` and `mcp__rednote__scroll("down")`
