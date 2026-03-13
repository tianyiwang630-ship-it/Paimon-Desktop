# Playwright MCP

This directory uses the official Playwright MCP package with a local wrapper.

Current project convention:
- The browser runs in explicit headed mode with `"headless": false`.
- The goal is to let users complete manual login, captcha, or risk-control flows in a visible browser window.
- Persistent profile reuse stays enabled with `"isolated": false`.
