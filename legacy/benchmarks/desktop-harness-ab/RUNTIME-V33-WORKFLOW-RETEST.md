# V33 workflow high 实测：覆盖改善，完整交付仍失败

2026-09-09 使用当前桌面 V3 入口，在与上次 Paw 延时重试相同的 GLM-5.3-Flash high、任务、20 分钟预算、64 次物理请求上限和 48 轮主循环上限下，完成一次新的真实 API 运行。

**独立验收从 28/34 到 33/34，但本次仍未完整交付。** README 缺失，自带测试直接重跑为 22/25、退出码 1，运行时到期中止，未进入独立完成审查。没有人工修复生成产物或追加模型重试。

| 指标 | 上次 Paw 延时重试 | V33 本次 |
|---|---:|---:|
| 运行时完整完成 | 否 | 否 |
| 复核后独立验收 | 28/34 | 33/34 |
| 总时长 | 1,200.163 秒 | 1,201.188 秒 |
| 物理请求 | 19 | 19 |
| 首次成功写文件 | 692.352 秒 | 636.167 秒 |
| 最长请求 | 595.832 秒 | 524.722 秒 |
| 已知总 token | 776,655 | 679,489 |
| 已知输入 / 输出 | 730,020 / 46,635 | 641,931 / 37,558 |
| 输入缓存命中 / 未缓存 | 304,512 / 425,508 | 366,144 / 275,787 |
| 用量未知的请求 | 1 | 1 |
| 自带测试直接重跑 | 48/50 | 22/25 |
| README | 缺失 | 缺失 |

总时长包含到期后的收尾开销，不能解读为成功交付时间。两次未知用量均未按零计算；缓存 token 包含在输入总量内，总 token 不是费用。自带测试的数量和覆盖不同，不能通过通过率直接排名。单次、顺序执行、同时变更预算机制和执行指引，不能把观察到的变化确认为因果收益，也不能宣称已超越 Claude Code。

## 实际生效与执行时间线

- 19 个主循环请求均经 wire 检查：模型为 `glm-5.3-flash`、effort 为 `high`、输出上限为 128,000；都包含渐进式验证指引和恰好一份宿主剩余时间提示。观察值单调递减。
- 第 3 次请求从约 14.9 秒开始，持续 524.722 秒后返回规划工具。其后第 4 次请求收到剩余 660 秒。这证明边界时间提示更新有效，不能证明它改变了该次思考策略。
- 636.167 秒首次写文件。904.961 秒才首次调用测试：`npm test 2>&1 | tail -40`，管道末端退出码不能证明测试成功。
- 随后用临时文件保存测试输出，再通过下一次 shell 调用读取；该环境的 `/tmp` 按调用隔离，后续读取失败。这是额外的验证往返。
- 1057.149 秒直接调用 `npm test`，失败可见。后面继续修改测试，1190.705 秒又执行 `npm test | tail` 并读取非标准的 `PIPESTATUS_0`，不能可靠保留 npm 的退出码。
- 第 15、16、17、18、19 次请求分别收到剩余 150、136、44、19、1 秒的收尾提醒。最后仍在发起模型请求，没有完成文档和最终验证闭环；请求在总截止时间被取消，最后一笔用量未知。

未启动数据库、Langfuse 或多 agent。沿用固定 Docker 镜像、隔离参数、任务和所有既有评分规则；本次是生产桌面宿主入口验证，不包括 Electron 原生窗口视觉验收。

## 交付质量复核

原始及补充复核分数都为 33/34。上次受 CLI `add` 参数个数错误阻挡的五组检查，本次全部通过。唯一失败组为 README 与测试入口交付组合检查中的 README 缺失。

独立直接执行自带 `npm test` 仍有三组失败。检查最终交付源码可见：

1. `test/cli.test.js:66` 在确认 `runAt=20` 后，以 `now=10` 期待再次领取成功，得到 `null` 后访问 `attempts` 报错。测试还把原本声称验证的“claim 自动过期并返回 null”路径换成了显式 expire，名称与验证范围已不一致。
2. `test/queue.test.js:136` 在任务已经完成后，要求无效结果操作必须抛 `TypeError`，但实现先报告非 running 状态，需求没有规定这两类错误的优先级；后续还期待已完成任务的结果恢复为 null，与先前成功完成断言矛盾。
3. `test/snapshot.test.js:72` 期待修改 `get()` 返回副本后能改变内部队列，与任务要求的深层隔离相反。

这三项是生成测试本身的具体问题，不应为了得到绿色结果去破坏正确的业务语义；但它们也仍然属于失败交付，不能把自带测试计为通过。独立 33 项检查通过不代表不存在其他未覆盖缺陷。

## 对下一步架构改进的含义

这次证据支持继续完善**验证与交付的状态记录**，而不是只追加更多提示词：

- 将要求的产物、已执行的用户路径、验证结果和受后续修改影响的检查关联起来。提醒不能替代覆盖判断；README 不能一直留到最后。
- 复用现有验证新鲜度与输出召回，明确区分诊断管道与可采信的测试退出码，避免用跨调用 `/tmp` 文件找错误。
- 测试失败时先对照需求和测试前提，再决定修改实现还是修复测试；不能把“使断言通过”当作目标。
- 为临近截止时间的新请求增加准入判断。本次剩余 1 秒仍启动请求，虽被正确取消，仍产生无效等待和未知成本风险。具体阈值需要独立实验，不能按这一个模型样本硬编码。

这些是后续建议，本次未继续修改运行时，也未在冻结运行中注入修复意见。长思考问题仍存在；首次动作稍早和已知用量较少，不能证明其根因已解决。

## 证据与复现

- [实际请求及预算核对](.runs/2026-09-09-v33-workflow-high/execution-budget-audit.json)
- [独立评分、自带测试全文与产物哈希](.runs/2026-09-09-v33-workflow-high/threeway-grade.json)
- [冻结配置与所选源码哈希](.runs/2026-09-09-v33-workflow-high/protocol.json)
- [最终交付副本](.runs/2026-09-09-v33-workflow-high/delivery/)
- [前次三方对照及限制](THREEWAY-WORKFLOW-2026-09-09.md)

原始响应、用量和产物均保留在 Git 忽略目录；九个交付文件的副本逐一校验 SHA-256，REQUIREMENTS.md 完整保留。任务与验收容器均已退出，未停止其他项目的服务。

```powershell
bun --env-file=.env.local benchmarks/desktop-harness-ab/tool-wire-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-09-v33-workflow-high --workflow --docker --single-agent --configured-profile --environment-audit --wall-and-call-budget
python benchmarks/desktop-harness-ab/threeway-grade.py benchmarks/desktop-harness-ab/.runs/2026-09-09-v33-workflow-high
python benchmarks/desktop-harness-ab/threeway-adjudicate.py benchmarks/desktop-harness-ab/.runs/2026-09-09-v33-workflow-high
python benchmarks/desktop-harness-ab/execution-budget-report.py benchmarks/desktop-harness-ab/.runs/2026-09-09-v33-workflow-high benchmarks/desktop-harness-ab/.runs/2026-09-09-threeway-paw-extended
```

复跑时必须使用新的输出目录；上述路径为本次保留的已完成样本。
