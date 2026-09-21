# GLM-5.3-Flash: Paw / Claude Code / ZCode workflow benchmark

## 实测结果

**所有运行均已结束并独立验收；在本次预算内，没有一个完整交付。** 任务是实现带依赖、租约过期、指数重试、故障恢复的持久化调度器，同时交付 CLI、测试和 README。统一 GLM-5.3-Flash high，20 分钟、64 次物理请求，主循环最多 48 轮（各原生运行时计数语义不同）。

| 运行 | 实际时长 | 请求数 | 首个项目文件 | 已上报总 token | 外部验收（复核后） | 自带测试重跑 | 停止原因 |
|---|---:|---:|---:|---:|---:|---:|---|
| Paw 原始 | 6分15秒 | 3 | 无 | 10,211 + 未知 | 0/34 | 无 | 6分钟纯思考保护 |
| Claude Code CLI | 19分32秒 | 48 | 6分30秒 | 2,096,704 | 33/34 | 52/61 | 原生48轮上限 |
| Paw 延时重试 | 20分00秒 | 19 | 11分32秒 | 776,655 + 未知 | 28/34 | 48/50 | 20分钟总预算 |
| ZCode bundled CLI | 20分01秒 | 14 | 15分10秒 | 550,718 + 未知 | 33/34 | 13/18 | 20分钟总预算 |

“+ 未知”均代表另有一次被中断的请求没有返回用量，不能把已知部分当作真实总消耗。Claude 缺少 `package.json`，无法执行要求的 `npm test`；表内 52/61 来自额外直接执行 `node --test`，并不表示它交付了可用的测试入口。各自测试数量和覆盖范围不同，不能用通过百分比直接给三者排名。所有运行都缺 README；Paw 重试产物还存在 CLI `add` 参数个数错误，五组外部 CLI 检查受阻。

| 运行 | 已知输入 token | 其中缓存命中 | 其中未缓存输入 | 已知输出 token | 用量未知的请求 |
|---|---:|---:|---:|---:|---:|
| Paw 原始 | 10,157 | 4,800 | 5,357 | 54 | 1 |
| Claude Code CLI | 2,043,439 | 1,966,912 | 76,527 | 53,265 | 0 |
| Paw 延时重试 | 730,020 | 304,512 | 425,508 | 46,635 | 1 |
| ZCode bundled CLI | 501,173 | 420,736 | 80,437 | 49,545 | 1 |

缓存 token 包含在总数内，因此总 token 不是费用。Claude 的用量最完整且缓存占比高；Paw 重试虽然已知总量较低，但未缓存输入更多，并有缺失用量，不能宣布更省钱。没有采用 CLI 的美元估算，也没有把未知用量记为零。

### 超时修改与实际效果

用户看到 Paw 第一轮失败后要求修改并重试。生产配置已改为：纯思考 **600秒**、单请求总时长 **900秒**、断流检测仍为 **90秒**，用户取消和禁止自动重复请求保持有效。新策略进入运行时身份。33 项针对性测试及模型包类型检查通过。

Paw 重试中，一次请求持续 **595.832秒**后才调用规划工具，随后成功写出实现。延时使这条实际响应得以转入执行，但没有使整项任务在20分钟内完成。两次 Paw 冻结的运行源码只有请求监督配置不同；重试是事后经用户要求增加的样本，不能伪装成初次成功或据此计算普遍成功率。

ZCode 同题也出现 **879.653秒**的长请求，之后才开始执行，返回34,704个输出token。本次没有证据支持“相同复杂任务在ZCode上不会长时间思考”。本次使用 high，不能把结论扩展到 max；原生提示词、工具和协议不同，也不能据此单独确定长思考的根因。

### 评分复核与证据

冻结脚本原始分数依次为 Paw 0、Claude 32、Paw 重试28、ZCode31（满分34）。复核发现两类超出需求的断言：要求私有令牌计数器恢复前后完全相同，以及要求返回的独立副本必须可写。补充检查验证实际承诺的状态/配置保留、令牌安全及隔离，对所有产物一视同仁应用，得到表内复核分数。原脚本、原始分数和修正记录均保留，下文详述；没有修改任何模型交付文件。

机器可读汇总：[comparison-summary.json](.runs/2026-09-09-threeway-preflight/comparison-summary.json)。原始请求、响应、分阶段用量、评分和带哈希的交付副本保存在以下 Git 忽略目录：

- [Paw 原始](.runs/2026-09-09-threeway-paw/threeway-grade.json)
- [Claude Code](.runs/2026-09-09-threeway-claude/threeway-grade.json)
- [Paw 延时重试](.runs/2026-09-09-threeway-paw-extended/threeway-grade.json)
- [ZCode](.runs/2026-09-09-threeway-zcode/threeway-grade.json)

每个目录下的 `delivery/` 是原交付的哈希核对副本。模型任务和验收容器已退出，本次没有启动数据库。单题、串行、不同原生配置且包含事后重试，只能说明这次表现，不能宣称某个产品整体更强。

## Frozen protocol

One fresh, sequential attempt per runtime: **Paw, Claude Code, ZCode**, in that order. Task: a durable dependency-aware scheduler with expiring leases, exponential retries, crash recovery, strict snapshot validation, atomic persistence, CLI, tests and README. The exact specification is [workflow-task.ts](workflow-task.ts). Every runtime receives the identical goal and fresh seeded workspace. Hidden acceptance is frozen before any live attempt; generated implementations are not repaired by the benchmark operator.

- Model: `glm-5.3-flash` on the same configured BigModel account. Reasoning intent: **high**. Maximum output: 128,000 tokens. Raw outgoing requests are retained and checked.
- Wall limit: 1,200 seconds; total physical model-request limit: 64. Root loop/turn limit: 48 (native semantics differ). No reported-token cutoff. Interrupted calls with missing usage remain unknown.
- Paw: current desktop V3 runtime through its production entry point, coding delegation disabled, independent completion audit retained and included in elapsed time and usage. This exercises the desktop runtime, not the native window UI.
- Paw's existing request supervisor remains active: idle 90 seconds, thinking-only 360 seconds, total per-request wall 600 seconds; experimental reasoning recovery is off, as in the default product path. The 20-minute external cap does not override these intrinsic limits. Native runtimes retain their own stopping behavior.
- Claude Code CLI 2.1.224: native system prompt; coding, search and progress tools; adaptive thinking plus `output_config.effort=high`.
- ZCode: official desktop-bundled CLI runtime 0.16.1, unmodified bundle; coding and progress tools, enabled thinking budget 32,000 plus `output_config.effort=high`. Bundle hash recorded per run.
- Cross-task memory, skills/plugins/MCP and coding delegation disabled. No database is started. API secrets stay on the host and are never passed to agent containers.
- Common image: `paw-claude-bench:2.1.224`, recorded immutable image ID, Node 24, npm, Bash, Git, ripgrep. Network denied, read-only root, dropped capabilities, 1 GiB memory, 2 CPUs, 128 PID limit. Fresh writable workspace and ephemeral `/tmp`.
- Paw uses its production Docker shell with host-side file tools. Native CLIs run entirely in a container (UID 1000), using a model-only file relay. Therefore process lifetime, shell startup, UID and relay overhead are not identical.
- Paw uses BigModel's OpenAI-compatible endpoint; native CLIs use BigModel's Anthropic-compatible endpoint. Native prompts and protocol-specific thinking representations are retained. This compares configured products, not an isolated causal change in one loop.

The native transport-only checks return a synthetic response and are excluded from benchmark time, token use and quality. Both confirmed actual high requests before the official runs. Provider interpretations of high/adaptive/budget are not guaranteed identical.

## Independent scoring

[verify-workflow.mjs](verify-workflow.mjs) checks 34 groups covering dependencies, cancellation, priority/FIFO, delay, retries, lease expiry, stale tokens, snapshot validation, clone isolation, arithmetic overflow atomicity, storage and CLI errors. It does not see the model's own test assertions.

Before live runs, [workflow-calibrate.py](workflow-calibrate.py) produced:

| Calibration variant | Acceptance groups passed |
|---|---:|
| Reference fixture | 34/34 |
| Accept stale token | 32/34 |
| Wrong expiry equality | 32/34 |
| Share mutable state | 27/34 |

[threeway-grade.py](threeway-grade.py) first grades the original read-only delivery, then executes `npm test` on a disposable copy. It records artifact hashes, requirements preservation, test counts, process result and provider usage. Grading time is outside agent completion time. Tests run without network and never execute generated code on the host.

Acceptance success, the agent's own test success, and the agent's completion status are reported separately. 34/34 is not proof of exhaustive correctness. Manual source review may add findings without altering frozen scores.

## Usage and speed interpretation

Provider-reported total includes repeated and cached context; it is not a price. Report input/output, cache hits, cache misses and missing-usage requests separately. For Anthropic wire format, merge cumulative usage updates per physical response instead of summing deltas. Normalize input as noncached input plus cache read/write where reported. For Paw OpenAI wire format, prompt tokens already include cached input. Preserve raw usage for cross-checking native CLI summaries. Unknown or incomplete usage is not zero.

Elapsed includes startup, tool execution, model requests and runtime closeout/audit. First successful write and first tool request supplement elapsed; they are not final completion. File observation and streamed tool events have different timing precision. A single sequential attempt is affected by provider load and cache/order effects; it cannot establish a general speed ranking or success rate.

## Reproduction

Run from repository root with locally configured ignored credentials:

```powershell
bun --env-file=.env.local benchmarks/desktop-harness-ab/tool-wire-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-paw --workflow --docker --configured-profile --environment-audit --single-agent --wall-and-call-budget
bun --env-file=.env.local benchmarks/desktop-harness-ab/claude-glm-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-paw benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-claude workflow
bun --env-file=.env.local benchmarks/desktop-harness-ab/zcode-glm-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-paw benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-zcode workflow
python benchmarks/desktop-harness-ab/threeway-grade.py benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-paw benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-claude benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-zcode
```

Output directories must be fresh. Raw private run artifacts remain Git-ignored under `.runs`; sanitized conclusions belong in this report. Run protocols retain source hashes and source snapshots.

Relevant primary documentation: [Claude Code CLI](https://code.claude.com/docs/en/cli-usage), [headless execution](https://code.claude.com/docs/en/headless), [BigModel thinking](https://docs.bigmodel.cn/cn/guide/capabilities/thinking).

## Results

Initial Paw attempt: 375.227 s, 3 physical requests, no generated code, 0/34 acceptance groups and no self-tests. The third request was stopped by the built-in 360-second thinking-only guard. Only the first two requests reported usage: 10,211 total tokens (10,157 input, 54 output, 4,800 cache read, 5,357 uncached input). The long interrupted generation has **unknown usage**, so 10,211 is a partial observed sum, not actual total cost.

### User-requested amendment during Claude's run

After observing this failure, the user explicitly requested changing `ModelReasoningWithoutActionTimeout` and retrying Paw. The production default is now thinking-only 600 seconds / per-request wall 900 seconds, with idle 90 seconds, parent cancellation and no automatic replay unchanged. The policy identifier includes the new values and changes the product identity. 33 focused model, desktop and identity tests plus model typechecking passed.

The original attempt remains in the record. The amended Paw attempt uses a fresh workspace with the exact same task, grader, high setting, image and external 20-minute / 64-request budget. This is a **post-observation retry**, not a blind first attempt. Run order was Paw original, Claude Code, Paw extended timeout, ZCode. Original and retry rows remain separate. All attempts and independent grading are now settled.

### Settled Paw retry and Claude findings

- Paw extended timeout: 1,200.163 s, 19 physical requests, external wall-budget abort, 28/34 acceptance groups and 48/50 self-tests passing. The first implementation write was at 692.352 s. Request 3 took 595.832 s and then called the task-planning tool; the old 360-second guard would have stopped this observed response. The completed request reported 21,255 output tokens. Snapshot hashes confirm `packages/models/src/request-supervision.ts` was the sole changed runtime source between the two Paw attempts.
- Paw retry known usage: 776,655 total, 730,020 input, 46,635 output, 304,512 cache read, 425,508 uncached input; one interrupted request has unknown usage. Independent audit was never reached. Generated `src/cli.js:24` incorrectly accepts 3..4 arguments for `add`, whose contract is 2..3 arguments. This one defect blocks five CLI acceptance groups. README is absent. Generated benchmark files are preserved without operator fixes.
- Claude Code: 1,171.835 s, 48 physical requests, native `error_max_turns` (not external wall timeout). First successful write: 389.628 s. Known usage is complete: 2,096,704 total, 2,043,439 input, 53,265 output, 1,966,912 cache read, 76,527 uncached input. Wire totals agree exactly with the native CLI usage summary. No `package.json` or README, so required `npm test` is unavailable. Supplemental direct `node --test` on a disposable copy yielded 52/61 passing, 9 failing. The final delivery is incomplete.

### Disclosed acceptance correction

The frozen round-trip check demanded exact equality of all snapshot internals, including the implementation's private token counter. The public task only requires preserved observable state/configuration and future token uniqueness. Claude safely advances its counter on restore, so the original check incorrectly failed a valid difference. **The original verifier and raw 32/34 score remain unchanged.**

[workflow-storage-adjudication.mjs](workflow-storage-adjudication.mjs) checks the promised behavior instead: unchanged job state and active lease, retained nondefault retry settings, distinct future tokens, failure propagation, independent state and temporary-file cleanup. [threeway-adjudicate.py](threeway-adjudicate.py) applies this same replacement group to every delivery, preserving both raw and reviewed scores. Claude's reviewed score is 33/34; both Paw scores are unchanged (0/34, 28/34). The supplement is a disclosed post-run grader correction, not additional instructions or hidden-test feedback to any agent.

The smaller Paw retry token sum does **not** establish lower cost: its incomplete known uncached input is much larger than Claude's, and its final interrupted request has no usage. No CLI USD estimate is treated as a BigModel invoice.

### ZCode and read-only-return adjudication

ZCode ran 1,200.687 s, made 14 physical requests and hit the external wall cap (exit 137). First generated file was `package.json` at 910.377 s; the third request lasted 879.653 s before completing. Known usage: 550,718 total, 501,173 input, 49,545 output, 420,736 cache read and 80,437 uncached input; one final request has unknown usage. `npm test` independently returned exit 1, 13/18 passing, 5 failing. README is missing and native final completion output is absent.

The raw score is 31/34: two groups failed because the grader tried assigning to frozen returned copies, and one for missing README. Source inspection confirms `src/queue.js:603` returns a **deep clone followed by deep freeze**; the input itself remains detached and writable. The task requires isolation but never requires mutable return values. [workflow-isolation-adjudication.mjs](workflow-isolation-adjudication.mjs) permits read-only copies while preserving all the original token, deadline, lease clearing and state-isolation assertions. All four deliveries received these same two replacement groups. Reviewed ZCode score is 33/34; the other reviewed scores are unchanged. The supplemental checks pass the reference fixture and both fail a deliberate shared-state mutant, with calibration saved alongside the original calibration.

No benchmark outcome is a proof of exhaustive correctness. Passing 33 acceptance groups while failing one's own tests and omitting deliverables remains an incomplete delivery. The figures should guide the next investigation, particularly time spent before the first implementation, task-wide budget allocation, direct end-to-end CLI verification, and context cache behavior.
