# V11：统一上下文预算与有效指导保留

2026-09-08。桌面新运行时组合版本 `paw.product-composition.v3.25:budgeted-context-guidance`。

## 问题与设计依据

原 V3 先调用 Runtime planner 选择历史，再由 composition 插入进度/恢复指导、转换运行状态。指导只能争用剩余预算，历史锚点被压缩或裁剪后就丢失。`plan()`、`build()` 和上下文占用事件因而可能代表不同请求。桌面启用的 `createToolDrivenMemoryContextV1` 也在 `build()` 最后追加记忆，绕过了预算。

本轮遵循以下原则，而非添加模型专用提示或改变回合阈值：

- [Anthropic 的 context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)：选择高信息量上下文，压缩时保留关键决定与未解决问题，避免不断堆积规则。该资料支持设计原则，不构成 Paw 效果提升的实测证据。
- [Aider 的 repository map](https://aider.chat/docs/repomap.html)：先在有限预算下选择相关内容。这是预算内选择的参考，并非直接迁移 Aider 的 repo map 算法。
- 旧运行时 `packages/agent/src/orchestrator.ts` 已有 `reserveRequestProjection`：先计算宿主状态/控制消息，再给历史分配预算。本轮迁移这一职责划分，同时保留新运行时的 canonical Journal、完整工具轮次和版本身份机制。

## 实现

1. Runtime 的 `plan()` 接收只影响模型视图的声明式投影：带来源位置的指导，以及可选插件证据。投影不能替换原始用户消息、模型消息或工具结果。
2. 有效指导、运行状态和原有受保护历史一起参与预算选择。仍按同一模型估算器计算整个请求；保留输出预留与软余量。必需内容连硬上限都放不下时明确失败，不静默丢指导或挤占输出。
3. 未压缩的指导继续紧贴其原始完整轮次。来源轮次不在上下文时，只为当前仍成立的 ordinary / closeout 条件提供 fallback，内容由当前日志重新推导。已通过的验证不会因旧指导被重新注入而再次变成“待验证”。历史提示仅在来源仍可见且有软预算空间时保留。
4. 可选记忆作为完整 section 按优先级选择，先考虑查询结果，再考虑 persona、topic index 和工具导航。放不下就不注入，不裁成断裂的 JSON。被拒绝的可选内容不计入压缩触发量，避免为无须注入的记忆反复压缩。
5. V3 与桌面产品记忆装饰器的 `build()` 都返回同一条 `plan()` 路径生成的请求。预算事件在最终投影完成后发出。仅提取指导策略到 `apps/cli/src/paw-next/request-guidance.ts`，没有引入新框架或服务。

主要代码：

- `packages/runtime/src/context/journal-context.ts`：预算、完整历史选择、可选内容准入和最终占用。
- `packages/runtime/src/context/journal-context-annotations.ts`：仅在完整轮次之间插入指导。
- `packages/runtime/src/context/journal-context-plan.ts`：声明式投影类型。
- `apps/cli/src/paw-next/request-guidance.ts`：稳定历史指导与有效 fallback 的纯日志投影。
- `apps/cli/src/paw-next/composition.ts`：V3 组合接线。
- `packages/memory-plugin/src/memory-context.ts`：桌面产品记忆路径进入统一 planner。

基础 V3 manifest 夹具 hash 为 `d5f222a5ba995d162e14f69aaa51d2d88a4d85f30a87c3f7211eaa2fda79c8f5`。实际配置另有其 hash。组合版本和 guidance mode 一并更新；旧 V1/V2 固定 hash 回归通过，不静默以新策略恢复旧 V3 身份。

## 验证

- **186 pass / 0 fail / 1060 assertions，12 个文件，76.71 秒**：桌面宿主、JSON IPC、审批、会话恢复、手动压缩、记忆插件、进度策略、Runtime 上下文及版本身份。
- **2 pass / 0 fail**：实际 composition 请求中只读进度指导保持原位、连续写入后的验证指导进入请求。
- 新增紧预算扫描、压缩覆盖来源后的有效 fallback、过期提示退出、完整工具交换不变、快照不修改、查询记忆一次解析、`plan/build` 一致性、最终占用与估算器一致性等检查。
- Runtime、CLI、memory-plugin 及桌面宿主 TypeScript 检查通过。依赖图无环，`git diff --check` 通过。
- composition 的一个多轮文件系统集成测试首次触发默认 5 秒测试超时；使用显式 30 秒集成测试上限重跑后两项均通过。没有修改产品运行期限来让测试通过。

```powershell
bun test packages/runtime/test/journal-context.test.ts packages/context-compaction/test packages/progress-advisor/test packages/memory-plugin/test/memory-plugin.test.ts apps/cli/test/paw-next-request-guidance.test.ts apps/cli/test/paw-next-product-v3.test.ts apps/desktop/test/runtimeHardening.test.ts apps/desktop/test/pawNext.test.ts --timeout 30000
bun test apps/cli/test/paw-next-composition-v2.test.ts --test-name-pattern 'advice|anchors verification' --timeout 30000
```

## 边界与后续

本轮没有真实 GLM/DeepSeek 复杂任务重测，没有证明完成率或 token 成本改善。预算是按既有模型估算器计算的请求预算，并非服务端 tokenizer 的精确计量。源锚点存在时保持历史提示稳定；发生压缩/裁剪后补回当前提示会改变请求前缀，不保证缓存命中率。

自动记忆仍沿用有界的按查询实例缓存；跨宿主重新启动后外部记忆可能变化。本轮未改变旧 `createMemoryContextV1` 路径，也没有将 terminal writer / organizer / dossier 改为持久后台队列。任务级成本核算、记忆收尾以及真实模型复杂任务对照仍需继续处理。
