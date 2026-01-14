# AI Multi-Window Chat - Tampermonkey Branch

<div align="center">

**A Tampermonkey userscript for multi-window AI conversations**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | [简体中文](README_zh.md)

</div>

## Overview

This is the **Tampermonkey branch** of AI Multi-Window Chat. It provides the same multi-window AI chat functionality as the browser extension, but runs as a userscript using Tampermonkey, Greasemonkey, or similar userscript managers.

> **Note**: For the browser extension version, please switch to the `main` branch.

## Features

- **Multi-Window Chat** - Open multiple independent chat windows at once
- **Floating Windows** - Drag, resize, minimize, and close
- **Text Selection** - Highlight text to launch a new chat with the selection
- **History Management** - Auto-save, reopen, delete, and export chats
- **Multiple Export Formats** - Export chats as Markdown (.md) or plain text (.txt)
- **Prompt Management** - Create, edit, delete, import, and export custom system prompts
- **Profile Management** - Manage multiple API configurations with import/export
- **OpenAI Compatible** - Works with any OpenAI-compatible API endpoint
- **Markdown & Math Support** - Lightweight built-in rendering (no external dependencies)

## Install

### Requirements

- [Tampermonkey](https://www.tampermonkey.net/) (recommended) or any compatible userscript manager (Greasemonkey, Violentmonkey, etc.)

### Installation Steps

1. Install Tampermonkey or a compatible userscript manager for your browser
2. Open [`ai-multi-window-chat.js`](ai-multi-window-chat.js) in raw view
3. Click "Install" in your userscript manager
4. Grant the necessary permissions when prompted

## Configure API

1. Click the Tampermonkey icon
2. Select "⚙️ Open Settings" or use the keyboard shortcut
3. In the settings panel, go to the **Config** tab
4. Click **New** to create a new profile
5. Fill in:
   - **Name**: A name for this configuration
   - **API URL**: e.g., `https://api.openai.com/v1`
   - **API Key**: your API key
   - **Model Name**: e.g., `gpt-4`
6. Click **Save** and then **Set Current** to activate it

### Quick Presets

The Config tab includes quick-fill buttons for popular services:
- **OpenAI**: `https://api.openai.com/v1`
- **DeepSeek**: `https://api.deepseek.com`
- **Qwen**: `https://dashscope.aliyuncs.com/compatible-mode/v1`

## Usage

- Select text on a page, then click **AI对话** in the floating toolbar
- Press `Alt+N` to open a new chat window with the current selection
- Press `Alt+Escape` to close all chat windows
- Click the window title to rename it
- Open the **History** tab to reopen, export, or delete chats
- Use the **Prompts** tab to manage custom system prompts
- Use the **Config** tab to manage multiple API configurations

### Import/Export

You can import and export your configurations and prompts:

1. Open settings (⚙️)
2. Go to **Config** or **Prompts** tab
3. Click **Export** to download your configurations/prompts as JSON
4. Click **Import** to load previously exported configurations/prompts

## Technical Notes

This Tampermonkey version is completely self-contained with:
- No external library dependencies (marked.js, katex.js removed)
- Built-in lightweight Markdown and math formula rendering
- All styling included inline
- Compatible with GreasyFork and similar userscript repositories

## Development

This branch is maintained separately from the main browser extension. To contribute or report issues specific to the Tampermonkey version, please mention that you're using the `tampermonkey` branch.

## License

[MIT License](LICENSE)
