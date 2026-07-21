你在 /Users/Zhuanz/Documents/CS/项目/paw-ts 工作。只做 Phase 2 Task 2.2（见 plans/memory-phase2-quality.md）。

## 必做
1. packages/memory/src/shared/memory-quality.ts 新增并导出：
   extractExplicitRememberText(goal: string): string | null
   - 用 extractCleanMemoryQuery 清洗 goal
   - 抽出「记住…」「remember that…」「以后都用…」等约定
   - 命中 ephemeral（暗号/只回复/不要调用工具等，复用现有 EPHEMERAL 规则）→ null
   - 无显式记住 → null
2. packages/memory/src/db/modules/write/memoryWriter.ts 的 buildPreferenceFromGoal：
   - 优先 extractExplicitRememberText；否则 hasDurableMemorySignal 路径可保留
3. packages/memory/src/shared/memory-record.ts 与 packages/memory/src/index.ts 导出新函数
4. packages/memory/test/memory-quality.test.ts 加测：
   - 「记住以后单测用 vitest」→ 非 null
   - 「记住暗号词蓝鲸」→ null
   - 「hello」→ null
5. 跑 bun test packages/memory/test/memory-quality.test.ts 必须绿

## 禁止
改 desktop / migrations / evolution / agent。不新增依赖。

完成后输出改动文件列表与测试结果。
