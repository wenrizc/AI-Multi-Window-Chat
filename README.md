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
- **Prompt Management** - Create, edit, delete, import, and export custom system prompts
- **Flexible Model Settings** - Configure transport, reasoning format, streaming, and context window per model
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
2. Build the background service worker:
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
   - **Streaming / Max Context Messages**: set per-model response behavior
3. Click "Save Config"

## Usage

- Select text on a page, then click **AI Chat** in the floating toolbar.
- Press `Alt+N` to open a new chat window with the current selection.
- Press `Alt+M` to close the most recently opened chat window.
- Click the window title to rename it.
- Open the **History** tab to reopen, export, or delete chats, and export history as Markdown or JSON.
- Use the **Prompts** tab to manage custom system prompts for your conversations.
- Use the **Config** tab to manage multiple API configurations, reasoning format, streaming, and context window limits.

## License

[MIT License](LICENSE)
