# AI 多窗口聊天 - 篡改猴分支

<div align="center">

**多窗口 AI 对话油猴脚本**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | [简体中文](README_zh.md)

</div>

## 概述

这是 **AI 多窗口聊天的篡改猴（Tampermonkey）分支**。它提供与浏览器扩展相同的多窗口 AI 聊天功能，但以用户脚本（userscript）的形式运行，需要配合 Tampermonkey、Greasemonkey 或类似的脚本管理器使用。

> **注意**：如需浏览器扩展版本，请切换到 `main` 分支。

## 功能特色

- **多窗口聊天** - 同时打开多个独立的聊天窗口
- **浮动窗口** - 支持拖拽、缩放、最小化、关闭
- **选中文本** - 选中文本后快速开启新对话
- **历史管理** - 自动保存、重开、删除、导出
- **多种导出格式** - 支持导出为 Markdown (.md) 或纯文本 (.txt)
- **提示词管理** - 创建、编辑、删除、导入、导出自定义系统提示词
- **配置管理** - 管理多个 API 配置，支持导入导出
- **OpenAI 兼容** - 适配任意 OpenAI 兼容 API
- **Markdown 和数学公式** - 内置轻量级渲染（无外部依赖）

## 安装

### 环境要求

- [Tampermonkey](https://www.tampermonkey.net/)（推荐）或任何兼容的用户脚本管理器（Greasemonkey、Violentmonkey 等）

### 安装步骤

1. 在浏览器中安装 Tampermonkey 或兼容的脚本管理器
2. 在 GitHub 上打开 [`ai-multi-window-chat.js`](ai-multi-window-chat.js) 的原始文件视图
3. 点击脚本管理器中的"安装"按钮
4. 根据提示授予必要权限

## 配置 API

1. 点击 Tampermonkey 图标
2. 选择"⚙️ 打开设置"或使用快捷键
3. 在设置面板中，进入 **配置** 标签页
4. 点击 **新增** 创建新配置
5. 填写：
   - **名称**：配置名称
   - **API 地址**：例如 `https://api.openai.com/v1`
   - **API 密钥**：你的 API 密钥
   - **模型名称**：例如 `gpt-4`
6. 点击 **保存**，然后点击 **设为当前** 激活配置

### 快速预设

配置标签页包含常用服务的快速填充按钮：
- **OpenAI**：`https://api.openai.com/v1`
- **DeepSeek**：`https://api.deepseek.com`
- **Qwen**：`https://dashscope.aliyuncs.com/compatible-mode/v1`

## 使用方法

- 选中文本后点击浮动工具栏的 **AI对话** 按钮
- 按 `Alt+N` 打开新聊天窗口，内容为当前选中文本
- 按 `Alt+Escape` 关闭所有聊天窗口
- 点击窗口标题可重命名
- 在 **历史记录** 标签页中重开、导出或删除对话
- 在 **提示词** 标签页中管理自定义系统提示词
- 在 **配置** 标签页中管理多个 API 配置

### 导入/导出

支持导入和导出配置与提示词：

1. 打开设置（⚙️）
2. 进入 **配置** 或 **提示词** 标签页
3. 点击 **导出** 下载配置/提示词 JSON 文件
4. 点击 **导入** 加载之前导出的配置/提示词

## 技术说明

此 Tampermonkey 版本完全自包含，具有以下特点：
- 无外部库依赖（已移除 marked.js、katex.js）
- 内置轻量级 Markdown 和数学公式渲染
- 所有样式内联包含
- 兼容 GreasyFork 等脚本仓库规范

## 开发

此分支与浏览器扩展主分支分开维护。如需贡献或报告 Tampermonkey 版本的问题，请说明你使用的是 `tampermonkey` 分支。

## 许可

[MIT 许可](LICENSE)
