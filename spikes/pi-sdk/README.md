# PI SDK 技术验证

这个目录是 `TASK-001` 的隔离验证程序，不属于正式应用骨架。

验证程序使用 PI SDK 的 faux provider 产生确定性响应，不读取 API Key，不调用付费模型。它覆盖：

- `createAgentSession()` 创建和释放会话；
- `defineTool()` 注册类型化只读工具；
- `session.subscribe()` 记录消息、工具和 Agent 生命周期事件；
- faux provider 的确定性错误传播；
- `session.abort()` 取消当前运行；
- 应用层超时触发取消。

## 启动

在干净环境中执行：

```bash
npm install
npm run check
npm start
```

预期输出是 JSON 格式的验证结果。程序不会安装或执行任何目标仓库代码，也不需要模型 API Key。

## 参考

- 本验证程序依赖 `@earendil-works/pi-coding-agent@0.86.1`。
- PI 源码参考位于项目根目录的 `pi/`，只读且被根 `.gitignore` 排除。
- 这里的 `fauxProvider` 只用于确定性验证，不代表生产模型接入方案。
