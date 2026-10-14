# Changelog

## 2.1.0 — Unreleased

### 中文

- 新增对话分支、消息编辑与重新生成，以及同级消息版本切换；请求发送当前活动分支的完整历史。
- 支持图片、文本和 Markdown 附件，保留图片历史及编辑、重新生成时的附件。
- 支持按模型配置自定义推理等级，改善兼容服务的推理内容解析与历史回传。
- 新增服务商鉴权模式、自定义请求头及网络超时处理；连接测试使用实际配置的传输协议。
- 升级到 schema v5 的分会话存储，提供旧数据迁移、写入串行化、去重及失败恢复。
- 改善设置和聊天界面、窄屏布局、消息滚动、提示词选择持久化与请求快照。
- 修复流式事件解析、Markdown 安全渲染、错误处理及中英文本地化问题。
- 完善 Vitest 分层测试、Playwright 扩展工作流测试及可选 DeepSeek 实测流程。

### English

- Added conversation branching, message editing/regeneration and sibling version navigation; requests include the full active branch history.
- Added image, text and Markdown attachments, with image history retained during editing and regeneration.
- Added custom per-model reasoning levels and improved compatible reasoning parsing and history replay.
- Added provider authentication modes, custom headers and network timeout handling; connection tests use the configured transport.
- Migrated to schema v5 per-chat storage with legacy migration, serialized writes, deduplication and failure recovery.
- Improved settings/chat usability, narrow layouts, scrolling, prompt selection persistence and request snapshots.
- Fixed stream parsing, safe Markdown rendering, error handling and English/Chinese localization.
- Expanded layered Vitest tests, packaged-extension Playwright workflows and optional live DeepSeek tests.

## 2.0.0 — 2026-06-02

See the [v2.0.0 release notes](https://github.com/wenrizc/AI-Multi-Window-Chat/releases/tag/v2.0.0) for the previously published release.
