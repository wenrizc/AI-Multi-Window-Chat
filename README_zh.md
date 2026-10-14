# AI 多窗口对话

<div align="center">

**现代化的多窗口 AI 对话浏览器扩展**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) | [简体中文](README_zh.md)

</div>

## 概述

AI 多窗口对话允许你在任意网页上打开多个可拖拽的聊天窗口，将选中的文字发送到新对话，并管理/导出对话历史。通过配置 API 地址、密钥和模型，可对接任何 OpenAI 兼容接口。

**项目网站**: [https://wenrizc.github.io/AI-Multi-Window-Chat/](https://wenrizc.github.io/AI-Multi-Window-Chat/)

## 功能特色

- **多窗口聊天** - 同时打开多个独立的聊天窗口
- **浮动窗口** - 支持拖拽、缩放、最小化、关闭
- **选中文本** - 选中文本后快速开启新对话
- **历史管理** - 自动保存、重开、删除、导出
- **多种导出格式** - 支持导出为 Markdown (.md) 或 JSON (.json)
- **对话分支** - 编辑、重新生成并继续不同的消息分支
- **附件支持** - 向兼容的模型发送图片，并将文本或 Markdown 文件内容加入消息
- **提示词管理** - 创建、编辑、删除、导入、导出自定义系统提示词
- **灵活模型设置** - 可配置服务商传输方式和鉴权，以及各模型的推理格式、流式响应和自定义推理等级
- **联网搜索与工具调用** - 可选使用 Tavily 搜索，并查看工具调用状态和来源
- **推理与用量展示** - 在服务支持时显示推理内容和 token 用量
- **OpenAI 兼容** - 适配任意 OpenAI 兼容 API

## 安装

### 通过 Chrome 网上应用店安装

可直接通过 Chrome Web Store 安装：

- https://chromewebstore.google.com/detail/ai-multi-window-chat/jeegcgffcgpeojhgjmgmjahhgdmcnacm?hl=zh-CN

### 快速安装

1. 从 [Releases](https://github.com/wenrizc/AI-Multi-Window-Chat/releases) 页面下载最新版本的发布包
2. 解压下载的 zip 文件
3. 打开 Chrome 并访问 `chrome://extensions/`
4. 开启右上角"开发者模式"
5. 点击"加载未打包的扩展程序"，选择解压后的文件夹

### 从源码安装

1. 安装依赖：
   - `npm install`
2. 将完整扩展构建到 `release/`：
   - `npm run build`
3. 打开 Chrome 并访问 `chrome://extensions/`
4. 开启右上角"开发者模式"
5. 点击"加载未打包的扩展程序"，选择 release 目录

## 配置 API

1. 点击扩展图标打开设置弹窗
2. 在 **配置** 标签页中填写：
   - **API URL**：例如 `https://api.openai.com/v1`
   - **API Key**：你的 API 密钥
   - **模型名称**：例如 `gpt-5`
   - **Transport**：`chat_completions` 或 `responses`
   - **推理格式**：选择服务实际返回的推理字段格式
   - **流式响应 / 推理等级**：按模型设置响应方式和推理等级
3. 点击“保存配置”

## 使用方法

- 选中文本后点击浮动工具栏的 **AI Chat** 按钮。
- 按 `Alt+N` 打开新聊天窗口，内容为当前选中文本。
- 按 `Alt+M` 关闭最近打开的聊天窗口。
- 点击窗口标题可重命名。
- 在 **历史记录** 标签页中重开、导出或删除对话，并可将历史导出为 Markdown 或 JSON。
- 在 **提示词** 标签页中管理自定义系统提示词。
- 聊天窗口中切换提示词会立即保存，后续发送、编辑和重新生成使用当前选择；“无提示词”不会被全局默认值覆盖。正在生成的回复及失败重试保留原请求的提示词。切换会保留历史消息，不会清除旧回答的影响。
- 新生成的消息保存实际使用的提示词名称与内容快照；已有历史消息无法补回未记录的旧提示词内容。
- 在 **配置** 标签页中管理多个 API 配置，并设置推理格式、流式响应和推理等级。
- 在聊天窗口设置面板中切换当前对话的模型、提示词、搜索、流式响应和推理等级。请求会包含当前活动分支的完整历史。
- 对消息使用“编辑”或“重新生成”可创建替代分支，并通过版本控件切换同级版本。

## 开发与版本记录

当前源码版本为 `2.1.0`；已发布的版本请查看上方 Releases 页面。更新内容见 [CHANGELOG.md](CHANGELOG.md)，开发与测试流程见 [TESTING.md](TESTING.md)。

```bash
npm run typecheck        # TypeScript 检查
npm run test             # 单元、集成与浏览器组件测试
npm run build            # 构建 release/ 扩展包
npm run test:e2e         # 使用构建后的扩展运行端到端测试
```

## 许可

[MIT 许可](LICENSE)
