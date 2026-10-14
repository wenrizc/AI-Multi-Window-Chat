# AI Multi-Window Chat

<div align="center">

**A modern browser extension for multi-window AI conversations**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | [简体中文](README_zh.md)

</div>

## Overview

AI Multi-Window Chat lets you open multiple draggable chat windows on any page, send selected text to a new chat, and manage/export conversation history. It works with OpenAI-compatible APIs by configuring a base URL, API key, and model.

**Website**: [https://wenrizc.github.io/AI-Multi-Window-Chat/](https://wenrizc.github.io/AI-Multi-Window-Chat/)

## Features

- **Multi-Window Chat** - Open multiple independent chat windows at once
- **Floating Windows** - Drag, resize, minimize, and close
- **Selection** - Highlight text to launch a new chat with the selection
- **History Management** - Auto-save, reopen, delete, and export chats
- **Multiple Export Formats** - Export chats as Markdown (.md) or JSON (.json)
- **Conversation Branching** - Edit, regenerate, and continue alternative message branches
- **Attachments** - Send images to compatible models and include text or Markdown files in messages
- **Prompt Management** - Create, edit, delete, import, and export custom system prompts
- **Flexible Model Settings** - Configure provider transport and authentication, plus per-model reasoning format, streaming, and custom reasoning levels
- **Web Search and Tool Calls** - Optionally search with Tavily and inspect tool activity and sources
- **Reasoning and Usage** - Display provider reasoning output and token usage when available
- **OpenAI Compatible** - Works with any OpenAI-compatible API endpoint

## Install

### Install from Chrome Web Store

Install directly from the Chrome Web Store:

- https://chromewebstore.google.com/detail/ai-multi-window-chat/jeegcgffcgpeojhgjmgmjahhgdmcnacm?hl=en-US

### Quick Install

1. Download the latest release package from the [Releases](https://github.com/wenrizc/AI-Multi-Window-Chat/releases) page
2. Extract the downloaded zip file
3. Open Chrome and go to `chrome://extensions/`
4. Enable "Developer mode" (top right)
5. Click "Load unpacked" and select the extracted folder

### Install from Source

1. Install dependencies:
   - `npm install`
2. Build the complete extension into `release/`:
   - `npm run build`
3. Open Chrome and go to `chrome://extensions/`
4. Enable "Developer mode" (top right)
5. Click "Load unpacked" and select the release folder

## Configure API

1. Click the extension icon to open the settings popup
2. In the **Config** tab, fill in:
   - **API URL**: e.g., `https://api.openai.com/v1`
   - **API Key**: your API key
   - **Model Name**: e.g., `gpt-5`
   - **Transport**: `chat_completions` or `responses`
   - **Reasoning Format**: choose the format your provider returns
   - **Streaming / Reasoning Effort**: set per-model response behavior and reasoning level
3. Click "Save Config"

## Usage

- Select text on a page, then click **AI Chat** in the floating toolbar.
- Press `Alt+N` to open a new chat window with the current selection.
- Press `Alt+M` to close the most recently opened chat window.
- Click the window title to rename it.
- Open the **History** tab to reopen, export, or delete chats, and export history as Markdown or JSON.
- Use the **Prompts** tab to manage custom system prompts for your conversations.
- Prompt switches are saved immediately. Sending, editing, and regenerating use the current selection, including explicit no prompt; in-flight replies and retries retain the original request prompt. Switching preserves conversation history and the influence of earlier replies.
- New messages save the actual prompt name and content as a snapshot. Older messages cannot recover prompt content that was never recorded.
- Use the **Config** tab to manage multiple API configurations, reasoning format, streaming, and reasoning effort.
- Use the chat settings panel to change the model, prompt, search, streaming, and reasoning effort for the current conversation. Requests include the full history of the active branch.
- Use **Edit** or **Regenerate** on a message to create an alternative branch, then switch between sibling versions with the version controls.

## Development

See [CHANGELOG.md](CHANGELOG.md) for version changes. The current source version is `2.1.0`; release availability is listed on the Releases page above.

### Testing

The extension ships with a full Vitest + Playwright test system:

```bash
npm run typecheck       # TypeScript project check
npm run test            # unit + integration + browser component tests
npm run test:unit       # pure Node unit tests
npm run test:integration # background / provider / fake-LLM tests
npm run test:browser    # component tests in real Chromium
npm run test:coverage   # coverage report (text, html, lcov)
npm run test:e2e        # loads the built release/ extension in Chromium
npm run test:e2e:deepseek # builds and tests the extension with the real DeepSeek API
```

See [TESTING.md](TESTING.md) for the architecture, fake LLM setup, and how to add new tests.

## License

[MIT License](LICENSE)
