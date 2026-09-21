# V12 桌面单 agent 实测：high 完成交付，max 仍出现长时间纯思考

日期：2026-09-08。四个独立样本均通过真实 `runDesktopNext` 入口使用最新 V3 组合：`paw.product-composition.v3.26:bounded-memory-maintenance`。

结论：小任务 high/max 都通过；复杂队列任务 high 在 676.511 秒内完整交付并通过独立验收，max 在第三次请求只输出思考，被既有 180 秒监督器停止，未生成实现。**这不是成功率统计，也不是 V12 相对旧版本的严格 A/B。**

## 条件与可比性

- GLM-5.3-Flash，原生主请求 `max_tokens=128000`。普通档定义为当前模型支持的 `high`，对照为 `max`；不是关闭思考。
- 顺序：小任务 high → 小任务 max → 复杂任务 high → 复杂任务 max。每个条件只运行一次，失败没有重试、替换或隐藏。
- high 仅在 benchmark 的实际 HTTP 请求中使用已有 `high-native` 覆盖函数，并在该实验模型的 runtime profile 中记录 high。小额度辅助请求不改写；用户本地配置没有改变。实际发送的 JSON 是参数核验依据，底层 observer 的 request 元数据可能仍记录覆盖前的 max。
- 同一任务两档的第一次请求，在仅去掉 `reasoning_effort`、标准化临时工作区路径后完全一致，包括 system prompt、用户消息、工具定义、温度和其他字段。队列规范化首请求 SHA-256：`e975d81926c38429053bb91d1fae4d9e0c26fa703f480e3de1a280b3a4f2fcb0`。后续消息因模型选择不同而分化。
- 四组冻结源码 hash、基线模型配置和容器镜像一致。源码快照保存在每个实验目录，报告器复核这些约束。
- 隔离 Docker Shell，镜像固定为 `sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf`；只挂载临时工作区，无网络、只读容器根目录，2 CPU/1 GiB 上限。预检通过，无 Desktop 重启。
- 单 agent：移除委派工具，关闭独立环境 auditor 和外部记忆，保留辅助完成审查。没有 Langfuse，没有自动思考恢复。因此这次**没有测量完整默认桌面的独立审计、记忆写入或原生 Electron 展示性能**。
- 小任务 180 秒 / 8 次模型调用 / 4 步；复杂任务 720 秒 / 40 次调用 / 32 步。均关闭累计 reported-token 截止阈值，保留 wall/call/step 限制。它不能与历史 160k token 截止条件直接比较效率。

## 结果

| 任务 | 推理档 | 总耗时 | 首个成功工具 | 首次成功写文件 | 模型请求 | 独立验收 | 交付的自测 | 运行时状态 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 写入并读回精确内容 | high | 17.779 s | 6.111 s | 6.111 s | 4 | 精确字节通过 | 不要求 | completed |
| 写入并读回精确内容 | max | 19.439 s | 6.027 s | 6.027 s | 4 | 精确字节通过 | 不要求 | completed |
| 持久队列、存储、CLI、测试、README | high | 676.511 s | 6.747 s | 90.107 s | 23 | **15/15** | **24/24，通过** | completed |
| 相同复杂任务 | max | 193.049 s | 7.131 s | 没有写入 | 3 | **0/15** | 未生成 | incomplete |

首个成功工具可能只是读取或环境检查，不能等同于开始实现。复杂任务的独立验收覆盖优先级/FIFO、状态与重试、完成后去重、嵌套防御复制、快照验证和恢复、原子存储、CLI 持久化/错误输入、README 与测试命令。生成的测试和独立验收均在任务结束后放入容器执行；独立验收器对 agent 不可见，工作区以只读方式挂载给独立验收。

## 时间具体花在哪里

high 复杂任务：

| 分类 | 耗时 | 含义 |
| --- | ---: | --- |
| 主 agent 的 22 次模型请求 | 551.608 s | 约 81.5% 总时间，包含等待响应、思考和生成正文/工具参数 |
| 完成审查 | 3.523 s | 第 23 次辅助请求 |
| 工具活动时间 | 50.304 s | 合并重叠工具区间，避免并行工具重复计时；包含宿主工具准备与持久化等边界内工作 |
| 其余宿主时间 | 71.076 s | 总时间减去以上区间的余量，尚未细分为 journal、上下文或事件投影，不能直接命名为某个组件的 CPU 耗时 |

工具结果返回到下一个模型请求开始的间隔后期达到约 4–5 秒。它提示需要进一步给 journal 读取、上下文构建等阶段加分段计时；现有数据不足以判定具体实现的复杂度或瓶颈。

并非所有“没有执行新工具”的时间都是纯思考。例如 high 第 6 次请求耗时 77.541 秒，可观察的前段纯思考约 2.113 秒，随后输出包含 **17,404 个工具参数字符**。第 7 次请求耗时 112.481 秒，前段纯思考约 47.793 秒，工具参数 **17,158 字符**。完整文件写入参数尚未接收完时，运行时不能安全地提前执行文件写入。

high 的后半程也存在修复低效：对 `test/queue.test.js` 做了 7 次 edit，对 `src/queue.js` 做了 2 次 edit，对 `package.json` 做了 1 次 edit。有测试把 `restore` 后的 running 状态错误断言为 running，而需求规定 pending；模型最终修正并通过。不能把所有测试失败都算成运行时错误或实现错误。

## max 的停点已经定位到响应阶段

第三次请求在任务开始后 12.470 秒进入模型：

- 请求持续 **180.589 秒**；首个思考 delta 到中断约 **176.945 秒**，前几秒为首响应等待。
- 原始 SSE 中有 **27,808 个思考字符**，**0 正文字符、0 工具参数字符**；解析后也为 0 个工具调用。
- 终止原因是 `ModelReasoningWithoutActionTimeout`。对应 `packages/models/src/request-supervision.ts` 的 `reasoningOnlyMs: 180_000` 和仅思考、无行动分支。
- 没有进入完成审查或记忆收尾；没有自动重试；第三个请求没有返回 usage，其费用未知。

这排除了“本次模型已经发送工具调用、Paw 却没有执行”的解释，也排除了本次等待发生在完成审查或记忆写入阶段。它不证明所有 max 请求都会失败，也不能证明系统提示词/工具设计与模型策略不存在交互。首请求相同而推理档位不同，说明后续优化不能预先排除模型推理策略因素。

## 已有 harness 机制确实进入了真实请求

high 首次使用 `npm test 2>&1 | tail -40`。Shell 整体退出 0 不能证明测试 runner 成功。`packages/completion-review/src/evidence-projector.ts` 的退出码可信度投影和 `packages/progress-advisor/src/projector.ts` 的 verification-repair 提醒，在第 10 次及之后的实际请求中可见。模型随后直接运行 `node --test test/queue.test.js`，得到真实失败并继续修复。

这说明提醒到实际请求的路径可用；最终是否成功仍由独立验收判断。没有为本次样本改动生产 prompt、Agent Loop 或监督阈值。

## Token：区分累计上下文和生成量

| 条件 | 已报告累计 token | 其中输入 | 其中输出 | 输入缓存命中 | 用量完整性 |
| --- | ---: | ---: | ---: | ---: | --- |
| 小任务 high | 11,895 | 11,734 | 161 | 3,392 | 完整 |
| 小任务 max | 12,049 | 11,761 | 288 | 7,040 | 完整 |
| 复杂任务 high | 644,390 | 620,087 | 24,303 | 561,344 | 完整 |
| 复杂任务 max | 7,987，仅前两次 | 不代表全程 | 不代表全程 | 不代表全程 | 第三次未知 |

high 的已报告未命中缓存输入为 58,743 token。累计 644,390 含多轮重复上下文，不能称为生成了 64 万 token；这里不推算账单价格。max 的小数字不能作为省 token 的证据。high 虽成功，23 次请求和多轮自测修复仍有优化空间。

## 证据与复现

本机忽略目录：

- `.runs/2026-09-08-v12-minimal-high/`
- `.runs/2026-09-08-v12-minimal-max/`
- `.runs/2026-09-08-v12-queue-high/`
- `.runs/2026-09-08-v12-queue-max/`

每组包含 `protocol.json`、实际 `request-*.json`、原始 `response-*.sse`、`parsed.jsonl`、`wire.jsonl`、`phases.jsonl`、`events.jsonl`、最终结果及源码快照。复杂任务另有 `single-agent-report.json`；四组均有 `runtime-validation.json`。HTTP headers 和凭据不写入日志；运行目录保留用于复核。

```powershell
# 每条命令必须使用不同的全新目录；命令调用付费模型。
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <minimal-high-dir> --minimal --single-agent --wall-and-call-budget --docker --high
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <minimal-max-dir> --minimal --single-agent --wall-and-call-budget --docker
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <queue-high-dir> --queue --single-agent --wall-and-call-budget --docker --high
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <queue-max-dir> --queue --single-agent --wall-and-call-budget --docker
python benchmarks/desktop-harness-ab/single-agent-report.py <queue-high-dir>
python benchmarks/desktop-harness-ab/single-agent-report.py <queue-max-dir>
python benchmarks/desktop-harness-ab/runtime-validation-report.py <minimal-high-dir> <minimal-max-dir> <queue-high-dir> <queue-max-dir>
```

请求覆盖与独立 verifier 校准测试 4/4 通过；工具并发耗时合并检查通过；汇总器验证冻结源码、镜像、预算、初始请求一致性和实际主请求 effort/output 参数。`git diff --check` 通过，测试结束没有遗留 `paw-shell` 容器。

## 下一步

优先围绕这次成功路径降低多轮修复和重复上下文成本，并分解宿主约 71 秒的剩余时间；随后用更多任务和交错顺序复测 high/max。后台记忆队列另做持久化迁移与故障验收。当前样本不足以宣布长任务稳定性问题已解决，也不足以宣布某个默认档位在所有任务上最优。
