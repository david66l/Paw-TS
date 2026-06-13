# Paw-TS 架构设计升级计划：通过大厂 AI Agent 面试

## 目标画像

- **时间预算**: 4-6 周
- **目标岗位**: AI 应用/Agent 开发（偏全栈）
- **核心策略**: 不做"完美产品"，做"架构设计能扛住追问的精品骨架"
- **前提假设**: 已接真实 LLM、简历包装独立完成、面试官重点追问 Agent 架构设计

---

## 一、设计诊断：现有架构的面试风险地图

### 1.1 Orchestrator — 设计层面最大风险

**现状**: `AgentOrchestrator.run()` 1225 行，`run()` 方法本身 750 行

**面试官会问的问题链**:
> "你的 Agent 主循环怎么设计的？"
→ 你展示 750 行代码
> "一个方法 700+ 行，你怎么保证可测试性？如果我要加一个 Phase（比如 Pre-tool Validation），怎么插进去？"
→ **风险**: 你很难回答，因为代码确实是面条式的

**具体设计缺陷**:
1. **Phase 耦合**: model 调用、工具执行、压缩、plan_update、ask_user 全揉在一个 loop 里，没有 Phase Handler 抽象
2. **重复逻辑**: 并行工具和单工具的执行逻辑几乎完全重复（749-856 vs 1056-1145），只是 wrapper 不同
3. **状态分散**: `finalMessage` 在 8 个不同位置赋值，`emit({type:"run.completed"})` 重复 8 次
4. **竞态条件**: `checkpointSeq.n += 1` 在并行工具循环中是非原子的

**优化方向**: 拆成 Phase Handler 模式，每个 Phase 独立可测试

### 1.2 ContextManager — 算法设计会被 challenge

**现状**: `maybeTruncate()` 用 `while + shift()` 做截断

**面试官会问**:
> "消息历史截断你怎么做的？复杂度多少？"
→ "用 shift() 移除老消息..."
> "shift() 是 O(n)，循环里 shift 不是 O(n²) 吗？如果历史 1000 条呢？"
→ **风险**: 这是算法基础题，答不上来直接扣分

**具体设计缺陷**:
1. **O(n²) 截断**: `shift()` 导致数组元素整体前移，循环里反复 shift
2. **Token 估算粗糙**: `length / 4` 是玩具级别，中文场景误差 2-3 倍
3. **无消息优先级**: 截断时只按时间先后，没有保护关键消息（如包含 tool_result 的 vs 纯文本的）

**优化方向**: 用 `slice()` 替代 `shift()`，接入 tiktoken，引入消息优先级权重

### 1.3 模型抽象层 — 设计亮点，但不够深

**现状**: `LanguageModel` 接口定义了 `complete()` + `completeStream()`

**设计亮点**:
- 统一的 `ChatMessage` 类型，支持 `thinking` 和 `attachments`
- `normalizeToolCalls()` 做四种输出格式归一化（JSON lines / XML / markdown fence）
- `OpenAICompatibleModel` 和 `AnthropicCompatibleModel` 都实现了 `LanguageModel`

**面试官会问**:
> "为什么不用 OpenAI 原生的 function calling？"
→ 代码确实没支持原生 function calling，用的是 "JSON in content"
> "如果模型输出被截断了（truncated），你怎么处理？"
→ **风险**: 代码里没有 truncated 检测和续写逻辑
> "不同模型的 context window 不一样，你的 128K 硬编码怎么适配 32K 模型？"
→ **风险**: `CONTEXT_WINDOW = 128_000` 是常量

**优化方向**: 添加模型能力检测（context window / max output tokens），支持 truncated 续写

### 1.4 工具系统 — 设计有深度，但覆盖不完整

**设计亮点**:
- `classifyShellCommand()` 的语义分类（read-only vs mutating）有真实工程思考
- `toolRequiresApproval()` 支持动态审批策略
- `HarnessContext` 用 optional 依赖注入，降低耦合

**面试官会问**:
> "如果模型同时要求 `read_file` 和 `write_file`，你怎么处理？"
→ "并行执行..."
> "如果 `write_file` 写了一半进程崩溃了，文件是脏的，怎么办？"
→ **风险**: 没有原子写入（先写临时文件再 rename）
> "模型想写 `.env` 或 `~/.ssh/id_rsa`，你怎么拦截？"
→ **风险**: `isMutatingTool` 只检查 tool 名，不检查 args.path

**优化方向**: 添加路径安全策略（敏感文件黑名单），实现原子写入

### 1.5 上下文压缩 — 设计亮点，但策略可深挖

**设计亮点**:
- 三层渐进式压缩（Prune + Compactor + Memory）
- Head/Tail 保护策略
- Anti-Thrashing + 熔断机制
- Anchored 增量更新

**面试官会问**:
> "压缩后模型'失忆'了，忘记之前的决策，怎么办？"
→ **风险**: 压缩摘要的质量没有评估机制
> "如果连续多轮都在压缩，每次压缩都 Fork 子 Agent，成本怎么控制？"
→ **风险**: 没有压缩频率限制（只有 thrashing 检测）
> "压缩后原始消息彻底丢了，如果摘要漏了关键信息，能恢复吗？"
→ **风险**: 原始消息不可恢复

**优化方向**: 添加压缩质量评估（摘要 vs 原始的消息重合度），保留原始消息的 hash 索引

### 1.6 错误处理 — 设计薄弱

**面试官会问**:
> "LLM API 超时了怎么办？"
→ "有 120s timeout..."
> "超时后重试吗？指数退避？"
→ **风险**: 代码里没有重试逻辑，超时直接失败
> "MCP 服务器连接断了，整个 run 就挂了？"
→ **风险**: 确实如此，MCP 失败直接 `return failed`
> "plan_update 解析失败怎么办？"
→ **风险**: 直接 `run.failed`，没有 graceful degradation

**优化方向**: 添加重试机制（指数退避）、MCP 降级模式、plan_update 容错

---

## 二、升级路线图：聚焦"设计能扛住问"

### Phase 1: Orchestrator 重构（Week 1）

**目标**: 把 750 行的面条代码变成可讲的设计模式

#### 任务 1.1: Phase Handler 拆分
把 `run()` 拆成 6 个 Phase Handler：

```typescript
interface PhaseHandler {
  readonly name: string;
  canHandle(ctx: PhaseContext): boolean;
  execute(ctx: PhaseContext): Promise<PhaseResult>;
}

class ModelPhase implements PhaseHandler { ... }
class ToolPhase implements PhaseHandler { ... }
class CompressionPhase implements PhaseHandler { ... }
class PlanPhase implements PhaseHandler { ... }
class AskUserPhase implements PhaseHandler { ... }
class FinalAnswerPhase implements PhaseHandler { ... }
```

**面试话术**:
> "我用 Phase Handler 模式重构了主循环，每个 Phase 单一职责、独立可测试。新增一个 Phase（比如 Pre-tool Validation）只需要实现一个接口，不用改动原有代码。"

#### 任务 1.2: 消除重复逻辑
提取 `executeToolCalls()` 统一处理并行/单工具：

```typescript
private async executeToolCalls(
  calls: ToolCall[],
  ctx: ExecutionContext
): Promise<ToolResult[]>
```

**面试话术**:
> "之前并行工具和单工具有两套几乎重复的执行逻辑，我提取了统一的 `executeToolCalls`，内部用 Promise.all 处理并发，审批和 checkpoint 都在这一层统一做。"

#### 任务 1.3: 状态机显式化
用显式状态机替代散落的 `finalMessage` 赋值：

```typescript
type RunState = 
  | { type: "running"; turn: number }
  | { type: "completed"; message: string }
  | { type: "failed"; message: string }
  | { type: "waiting_approval"; pendingTools: ToolCall[] }
  | { type: "ask_user"; question: string };
```

**面试话术**:
> "我用显式状态机管理 Run 的生命周期，状态转移是单向的（running → completed/failed），每个状态有明确的入站和出站条件，避免了之前 8 个地方随意 return 的混乱。"

**W1 交付物**:
- Orchestrator 主循环 < 200 行
- 6 个 Phase Handler 各自 < 150 行
- 原有测试全部通过（保证重构没改行为）

---

### Phase 2: 核心算法优化（Week 2）

**目标**: 解决会被 challenge 的算法和工程问题

#### 任务 2.1: ContextManager 截断优化
- 用 `slice()` 替代 `shift()`，从 O(n²) 降到 O(n)
- 添加消息优先级：tool_result > user > assistant，截断时优先丢 assistant 的纯思考消息

**面试话术**:
> "早期用 shift() 做截断是 O(n²)，我改成 slice() 后 O(n)。还加了消息优先级权重——tool_result 消息最重要（包含执行结果），assistant 的纯思考消息最优先丢弃。"

#### 任务 2.2: Token 估算精确化
- 接入 `js-tiktoken`，按模型选择 tokenizer
- GPT-4/DeepSeek → cl100k_base
- Claude → 近似 cl100k_base
- 添加 `ModelCapabilities` 接口，每个模型声明自己的 context_window / max_output_tokens

```typescript
interface ModelCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly tokenizer: "cl100k" | "o200k" | "approx";
}
```

**面试话术**:
> "token 估算从 length/4 改成了 tiktoken，按模型选择对应的 tokenizer。我还抽象了 ModelCapabilities 接口，每个模型声明自己的 context window 和 tokenizer，压缩阈值可以动态计算，不再硬编码 128K。"

#### 任务 2.3: 路径安全策略
- 在 `write_file` / `edit_file` 工具层添加敏感路径检查
- 黑名单: `.env`, `.ssh/`, `.git/`, `node_modules/` (写操作)
- 用 `path.resolve + startsWith` 双重确认 workspace 逃逸

**面试话术**:
> "工具执行层加了路径安全策略：敏感文件黑名单 + workspace 逃逸检测。即使模型要求写 `.env`，工具层也会拦截，这是 defense in depth——prompt 层告诉模型不要写，工具层强制执行。"

**W2 交付物**:
- 截断算法优化 + 单元测试
- tiktoken 集成 + 误差 < 10% 的测试
- 路径安全策略 + 拦截测试

---

### Phase 3: Robustness 设计（Week 3）

**目标**: 让错误处理从"能跑"变成"生产可用"

#### 任务 3.1: LLM 调用重试机制
- 指数退避重试（max 3 次）
- 区分可重试错误（timeout / 5xx）和不可重试错误（4xx / 格式错误）
- truncated 检测：如果 `finish_reason === "length"`，自动续写

```typescript
async function callWithRetry(
  model: LanguageModel,
  messages: ChatMessage[],
  options: ModelCompleteOptions
): Promise<ModelCompletionResult> {
  // 指数退避，区分可重试/不可重试
}
```

**面试话术**:
> "LLM 调用加了指数退避重试，区分网络超时（可重试）和参数错误（不可重试）。如果模型输出被 truncated（finish_reason=length），我会把已输出的内容作为上下文，发一个 'continue' 请求续写。"

#### 任务 3.2: MCP 降级模式
- MCP 连接失败不终止 run，降级为无 MCP 继续
- 运行时 MCP 工具不可用 → 工具调用返回 "MCP server unavailable"

**面试话术**:
> "MCP 连接失败不再终止整个 run，而是降级为无 MCP 模式。模型如果调用了 MCP 工具，会收到 'server unavailable' 的提示，可以自动切换到本地工具。"

#### 任务 3.3: 原子写入
- `write_file` 先写 `.filename.paw.tmp`，成功后再 `rename`
- 失败时删除临时文件，保证不会留下脏文件

**面试话术**:
> "文件写入用原子操作：先写临时文件，成功后 rename。这样即使进程崩溃，不会留下半写文件。配合 checkpoint 系统，可以精确回滚到任意一次工具调用前的状态。"

**W3 交付物**:
- 重试机制 + truncated 续写 + 测试
- MCP 降级模式 + 测试
- 原子写入 + 测试

---

### Phase 4: 设计亮点包装（Week 4）

**目标**: 把已有的好设计讲成故事

#### 任务 4.1: 写架构文档
`docs/ARCHITECTURE.md`:
- 系统架构图（用现有 SVG）
- 每个包的设计职责和边界
- 关键设计决策（DDD 风格）

#### 任务 4.2: 写设计决策记录（ADR）
`docs/adr/` 目录，记录 5-8 个关键决策：
1. `001-phase-handler-pattern.md` — 为什么拆 Phase
2. `002-three-layer-compression.md` — 三层压缩设计
3. `003-shell-semantic-classification.md` — Shell 安全设计
4. `004-event-driven-architecture.md` — 事件驱动
5. `005-model-abstraction.md` — 模型抽象层
6. `006-checkpoint-snapshot.md` — Checkpoint 设计

#### 任务 4.3: 写面试 Q&A
`docs/INTERVIEW_QA.md`，预设 20 个高频问题 + 带代码引用的答案

**W4 交付物**:
- ARCHITECTURE.md
- 6 个 ADR
- INTERVIEW_QA.md

---

### Phase 5: 缓冲与演练（Week 5-6）

- 模拟面试 ≥ 3 次
- 根据反馈调整 ADR 和 Q&A
- 确保能 10 分钟不间断讲清楚架构

---

## 三、面试话术核心框架

### 开场（30 秒）
> "Paw-TS 是一个 AI Coding Agent，核心是一个多轮对话的 Agent 循环。我用 Phase Handler 模式把主循环拆成 6 个独立阶段，支持工具调用、上下文压缩、Checkpoint 回滚。设计上有三个我比较满意的点："

### 三个设计亮点（每个 1-2 分钟）

**亮点 1: Phase Handler + 显式状态机**
> "Agent 主循环最容易变成面条代码。我把 model、tool、compression、plan、ask_user 拆成独立的 Phase Handler，每个 Handler 单一职责、独立可测试。Run 的生命周期用显式状态机管理，状态转移是单向的，不会出现之前 8 个地方随意 return 的混乱。"

**亮点 2: 三层渐进式压缩**
> "长对话的 token 超限是核心难题。我设计了三层压缩：
> - Layer 1 Prune：零 LLM 调用，截断旧工具输出
> - Layer 2/3 Compactor：Fork 子 Agent 生成结构化摘要，同时沉淀为 Session Memory
> - 有 Head/Tail 保护、Anti-Thrashing、熔断机制"

**亮点 3: 双层安全模型**
> "AI 写代码最大的风险是安全问题。我设计了双层保护：
> - Prompt 层：system prompt 告诉模型安全规范
> - 工具层：Shell 语义分类器区分 read-only/mutating，敏感路径黑名单，workspace 逃逸检测
> 这是 defense in depth——即使 prompt 被绕过，工具层还会拦截。"

### 坦诚不足（15 秒）
> "当前是单进程单用户设计，多用户并发需要加文件锁。如果继续迭代，我会做语义搜索和 IDE 插件。"

---

## 四、不做的事（减法）

| 不做 | 原因 |
|------|------|
| Git 历史重构 | 简历不看 GitHub |
| CI/CD | 面试不问这个 |
| README 美化 | 包装简历时不写 |
| Docker 部署 | 不是面试重点 |
| Web App / IDE 插件 | 复杂度太高，6 周做不完 |
| 多用户并发 | 需要数据库/锁，超范围 |
| 向量语义搜索 | 当前骨架用不到 |
| CostTracker 精确化 | P3 优先级，面试不会深问 |

---

## 五、每周检查清单

### W1 结束标准
- [ ] Orchestrator 拆成 6 个 Phase Handler
- [ ] 主循环 < 200 行
- [ ] 原有测试全部通过

### W2 结束标准
- [ ] ContextManager 截断 O(n) + 消息优先级
- [ ] tiktoken 集成，按模型选择 tokenizer
- [ ] 路径安全策略（敏感文件黑名单）

### W3 结束标准
- [ ] LLM 调用重试 + truncated 续写
- [ ] MCP 降级模式
- [ ] 原子写入（tmp + rename）

### W4 结束标准
- [ ] ARCHITECTURE.md 完成
- [ ] 6 个 ADR 完成
- [ ] INTERVIEW_QA.md 完成

### W5-6 结束标准
- [ ] 模拟面试 ≥ 3 次
- [ ] 能 10 分钟不间断讲清楚架构
