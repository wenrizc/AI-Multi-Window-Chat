# 集成测试

运行：`npm ci` 后执行 `npm run test:integration`。静态检查：`npm run typecheck`。
测试不需要 LLM/Tavily API key，也不调用真实付费服务。

## 测试边界

- `providers.test.ts`：请求序列化、鉴权、响应解析、DSML 和 reasoning 兼容性。
- `provider-streams.test.ts`：Chat Completions / Responses 的字节分片、中文和 emoji、CRLF、心跳、末尾事件、解析/HTTP/网络失败与首字节超时。
- `search-session.test.ts`：两个协议下的直接回答、多工具、多轮搜索、轮数上限、工具结果回传、Responses ID 续接、非法工具/参数、空结果及搜索失败。
- `background.test.ts`：Chrome port → 后台 → provider/search → storage 完整链路，含事件顺序、重试去重、用量累加、搜索元数据落库、部分响应失败与窗口断开隔离。
- `aimock.test.ts`：保留 aimock 随机端口本地 HTTP 服务的协议冒烟测试，补充 MSW 拦截测试。

## 如何设计 LLM mock

在 HTTP 边界使用 `test/helpers/llm-mock.ts`，保留真实 provider、搜索会话、错误处理和持久化代码。不要 mock `completeProviderTurn` 或直接返回业务层结果，否则无法检查协议字段和模块协作。

`scriptedLlm(transport, steps, baseUrl?)` 的每一步接收真实请求及 JSON body，并返回 Response。用 `llmTurn` 创建正常响应，`HttpResponse` 创建 HTTP/JSON 异常，`byteSse` 创建流式响应。需要模拟特殊供应商格式时直接编写独立的 wire payload，避免复用生产序列化函数生成预期结果。

每个测试使用独立脚本，并在 `afterEach` 中调用 `verify()`：它检查所有步骤恰好执行一次，并重新抛出 handler 内的断言错误。MSW 会把 handler 抛错转为 HTTP 500，缺少这一检查可能让“预期失败”测试错误通过。所有 MSW server 都用 `onUnhandledRequest: 'error'`，缺失 mock 的请求立即失败。

多轮测试既断言最终回答，也检查后续请求中的工具 call ID、输出内容、`previous_response_id` 和工具开关；不能只按请求次数返回答案而不检查上下文。并发窗口使用不同 base URL 和独立脚本，避免共享队列依赖请求到达顺序。

`byteSse` 先编码 UTF-8 再切字节，能覆盖一个汉字或 emoji 跨 chunk 的情况。`deferred` 用于请求到达、取消和响应释放的同步；通过 `finally` 释放挂起的 handler。超时测试只虚拟化定时器并恢复时钟，不依赖长时间 sleep。

Chrome API 使用内存 mock，因此这里不覆盖浏览器对扩展权限、service worker 生命周期及真实 port 断开的实现；这些由 `npm run test:browser` 和 `npm run test:e2e` 对应的浏览器测试补充。服务端限流策略和实际模型回答质量也不属于这些确定性集成测试的验证范围。
