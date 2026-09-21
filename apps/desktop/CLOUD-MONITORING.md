# Paw 桌面端云端监控

桌面宿主采集少量运行元数据，使用 OpenTelemetry SDK 批量发送到 Langfuse Cloud。存储、检索、统计和开发者面板在云端；本地不部署 Collector、数据库或监控服务，不新增监控日志文件。

本地采集、计数和网络发送仍有少量 CPU、内存与带宽开销，不能做到零开销。已有 canonical journal、会话记录和任务恢复文件继续保留，它们属于运行时状态，不是可删除的监控副本。

## 创建项目并启用

1. 在 [Langfuse Cloud 欧洲区](https://cloud.langfuse.com/) 注册，创建一个名为 `Paw` 的项目。
2. 打开项目 **Settings → API Keys**，创建 Public Key 和 Secret Key。密钥只填在本地配置中，不提交 Git，也不发送给模型。
3. 编辑仓库根目录 `.paw/telemetry.local.json`：

```json
{
  "enabled": true,
  "baseUrl": "https://cloud.langfuse.com",
  "publicKey": "填入项目 Public Key",
  "secretKey": "填入项目 Secret Key",
  "sampleRate": 1
}
```

此文件被 `.gitignore` 排除。实际提供的模板默认 `enabled: false`、密钥为空。配置缺失、不完整或不合法时，不启动云端监控，Paw 仍可执行任务。密钥仅由 Bun 宿主读取，不进入 React 渲染进程。

4. **完全退出并重新启动 Paw**，让宿主读取配置。发起一个简单任务，在 Langfuse 的 Tracing/Observations 页面查找 `Paw desktop task`。

欧洲区项目使用上面的地址。其他区域必须使用创建项目时对应的地址和密钥，不能混用。HTTPS 接入地址和认证方式见 [Langfuse OpenTelemetry 文档](https://langfuse.com/integrations/native/opentelemetry)。

也可通过启动宿主的环境变量配置，它们优先于文件：

| 环境变量 | 含义 |
| --- | --- |
| `PAW_TELEMETRY_ENABLED=1` | 显式开启；设为 `0` 可关闭 |
| `LANGFUSE_BASE_URL` | 云端 HTTPS origin，不含 API 路径 |
| `LANGFUSE_PUBLIC_KEY` | 项目 Public Key |
| `LANGFUSE_SECRET_KEY` | 项目 Secret Key |
| `PAW_TELEMETRY_SAMPLE_RATE` | 0–1 的整条 trace 采样比例，默认 1 |

## 采集范围

同一桌面操作形成一条 trace。运行 journal 中的模型回合、工具调用、权限结果、后台活动、完成检查和压缩阶段形成关联的 span。主循环、子 Agent 与辅助调用的 `runId` 和阶段在进程内关联；上传的运行与调用标识使用哈希。

当前 OpenAI/GLM 和 Anthropic 适配器记录：

- 每次实际 HTTP 尝试及状态码，包括 OpenAI `stream_options` 400 回退。
- 实际输出上限、思考档位及流式/非流式模式，不修改模型请求参数。
- 流式首个字节块、首次思考、首次正文、首次工具片段、工具组装完成。
- 思考/正文字符数、接收字节数、工具片段数与组装调用数。
- 完成原因及服务端报告的输入/输出 token；没有 usage 时保持未知，不补成零。
- 取消和错误类别：HTTP、网络、解析、流异常或未知；不上传错误正文和堆栈。
- 活跃模型调用每 30 秒产生一次进度快照，包括当前状态和距上次接收数据的时间。

常规采集不重复解析 SSE，不保存原始响应，也不上传提示词、模型输出、思考正文、工具参数/结果、源码、文件路径、认证头或 API key。模型名称、工具名称和阶段名作为元数据上传。云端费用依赖项目对相应模型的计价配置，不能代替供应商账单。

## 开销与故障边界

- OpenTelemetry 私有 provider，不注册全局自动埋点，不截获其他网络请求。
- 每 5 秒批量发送，单批最多 64 个已结束 span，队列最多 256 个，HTTP 导出并发为 1。
- 每个桌面操作最多跟踪 128 个活跃模型调用、128 个待结算执行项及 128 个运行身份。
- 每个网络块只更新计数；首次里程碑只记录一次，不逐 token 上报。
- 导出超时为 2 秒，队列满或上报失败时可丢弃数据，不写磁盘补偿队列，也不等待云端再继续任务。
- 任务结束触发异步 flush。宿主正常退出最多等待 2.5 秒；崩溃或强制结束可能丢失尾部记录。
- 观测链路是 best effort，不替代用于安全恢复和执行证据的 canonical journal。

进度通常受 30 秒快照与 5 秒批量间隔影响；网络和云端处理还可能增加延迟。使用 `x-langfuse-ingestion-version: 4` 请求实时摄入。尚未结束的父 span 可能晚于进度事件出现在完整树中。

## 验证与限制

离线测试覆盖真实 Bun OTLP/HTTP 导出到临时回环接收器、桌面真实宿主的 trace 关联、两种协议的流式工具、400 回退、并发隔离、脱敏、取消、解析失败、采样关闭、队列相关上限及接收器 503 时模型仍继续返回。

```powershell
bun test packages/models/test/observation.test.ts apps/desktop/test/cloudTelemetry.test.ts
```

这些测试不调用付费模型，也不会向 Langfuse 发送数据。真实云端项目入库需要配置项目密钥后另行验收。

工具片段统计来自已有解析器；它能显示解析器收到的进展，不能独立证明原始 SSE 字段从未遗漏。此前的 `legacy/benchmarks/desktop-harness-ab/tool-wire-probe.ts` 仍是按需运行的本地原始流取证工具，不会随普通监控自动启用。
