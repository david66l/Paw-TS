# MemoryProvider 插件体系 — 实施计划

## Context

当前 paw-ts 的记忆存储完全耦合到文件系统（`AutoMemoryStore` → `~/.paw/.../memory/*.md`）。记忆一多（数百条），文件 I/O 检索成瓶颈——每次 `list()` 遍历整个目录，embedding 向量塞在 YAML frontmatter 里手动 base64 编解码。需要引入可插拔后端，但**不能破坏存量 MD 数据**。

## 核心设计

在 `AutoMemoryStore` 上面插一层 `MemoryProvider` 接口。FileProvider 封装现有 MD 逻辑（100% 向后兼容），外部 Provider 实现同一接口。SessionMemory 不受影响。

```
之前: Agent → AutoMemoryStore (文件 I/O 直接)
      Agent → UnifiedMemoryStore → AutoMemoryStore + SessionMemoryStore

之后: Agent → MemoryProvider (接口)
        ├── FileProvider (封装 AutoMemoryStore, 默认)
        └── ExternalProvider (SQLite/mem0/... 未来)
      Agent → UnifiedMemoryStore → MemoryProvider + SessionMemoryStore
```

## MemoryProvider 接口

新文件: `packages/memory/src/memory-provider.ts`

```typescript
interface MemorySearchQuery {
  goal: string; limit?: number; queryEmbedding?: number[];
  currentFile?: string; recentFiles?: readonly string[];
  errorMessage?: string;
}

interface MemoryProvider {
  readonly name: string;
  initialize(workspaceRoot: string): Promise<void>;
  isAvailable(): boolean;
  shutdown(): Promise<void>;

  // 检索：返回 MemoryRecord[]，上层 pipeline 继续打分/排序
  searchMemory(query: MemorySearchQuery): Promise<MemoryRecord[]>;

  // 写入：upsert + 自动重建索引（buildIndex 是 provider 内部实现细节）
  saveMemory(entry: AutoMemoryEntry): Promise<"created" | "updated">;
  deleteMemory(name: string): Promise<void>;

  // 索引：注入 system prompt 用
  loadIndex(maxLines?: number): string | null;

  // 维护：LLM callback 注入，provider 不持有模型引用
  consolidate(complete: (sys: string, user: string) => Promise<string>)
    : Promise<{ modified: number }>;
}
```

## FileProvider

新文件: `packages/memory/src/file-provider.ts`

纯适配器，委托 `AutoMemoryStore`:

| 接口方法 | 委托 |
|---|---|
| `searchMemory` | `store.list()` → `autoMemoryToRecord()` |
| `saveMemory` | `store.upsert()` + `store.buildIndex()` |
| `deleteMemory` | `store.delete()` |
| `loadIndex` | `store.loadAllIndexShards()` ?? `store.loadIndex(200)` |
| `consolidate` | `runReflection(store, complete)` |

## 改动清单

### Phase 1: 接口 + FileProvider（memory 包）

1. **新建** `packages/memory/src/memory-provider.ts` — 接口定义
2. **新建** `packages/memory/src/file-provider.ts` — FileProvider 实现  
3. **修改** `packages/memory/src/unified-memory-store.ts`:
   - 构造函数接受可选 `MemoryProvider`，未提供则默认 `new FileProvider()`
   - `autoStore: AutoMemoryStore` → `provider: MemoryProvider`
   - `list()` → `async list(): Promise<MemoryRecord[]>`（searchMemory 是 async）
   - `getAutoMtime()` 移入 FileProvider
4. **修改** `packages/memory/src/memory-retriever.ts`:
   - `rankRecords()` / `retrieve()` / `buildResult()` → async
5. **修改** `packages/memory/src/memory-retrieve.ts`:
   - 加 `await` 到 `retriever.retrieve()` 和 `store.listExcludingCurrent()`
6. **修改** `packages/memory/src/index.ts` + `packages/core/src/index.ts` — 导出新类型

### Phase 2: Agent 代码接入（agent 包）

7. **新建** `packages/agent/src/resolve-memory-provider.ts`:
   - 读 `.paw/settings.local.json` → `memory_provider` 字段，默认 `"file"`
8. **修改** `packages/agent/src/orchestrator.ts`:
   - `initializeRun()`: `new AutoMemoryStore(...)` → `resolveMemoryProvider()`+`await provider.initialize()`
   - 返回类型: `autoMemoryStore` → `memoryProvider`
   - `memoryIndex` 从 `provider.loadIndex()` 获取
   - 相关方法签名: `AutoMemoryStore` → `MemoryProvider`
9. **修改** `packages/agent/src/orchestrator/memory-extraction.ts`:
   - `autoMemoryStore.upsert()` → `await provider.saveMemory()`
   - `autoMemoryStore.buildIndex()` → 删除（saveMemory 内部已含）
   - embedding 提前计算 → 一次 saveMemory 替代 load→modify→save 双写
   - `runReflection` → `provider.consolidate(complete)`
10. **修改** `packages/agent/src/orchestrator/session-summarizer.ts`:
    - `autoMemoryStore.upsert()` → `await provider.saveMemory()`
    - `autoMemoryStore.buildIndex()` → 删除

### Phase 3: Reflection 重构

11. **修改** `packages/memory/src/memory-reflector.ts`:
    - 核心逻辑移入 `FileProvider.consolidate()` 私有方法
    - 保留 `runReflection` 导出（标记 deprecated，委托 FileProvider）

## 不改的文件

- `auto-memory.ts` — FileProvider 内部使用，公共 API 不变
- `session-memory.ts` — 完全不变（需求明确：会话记忆永远本地文件）
- `memory-record.ts` / `memory-scorer.ts` / `memory-selector.ts` — 不变
- `embedding-cache.ts` — 不变

## 关键决策

1. **FileProvider.searchMemory 返回全量**：不预过滤，跟现在行为一致。上层 scoring pipeline 不变。外部 provider 可用原生向量搜索预过滤后交给 pipeline 精排
2. **SessionMemory 不动**：只抽象 AutoMemory 层
3. **async 涟漪可控**：`list()` 变 async → `rankRecords` → `retrieve` → `retrieveMemories`。`retrieveMemories` 已经是 async，agent 层无感知
4. **embedding 提前计算**：消除 load→modify→save 双写，也避免给接口加 `loadEntry` 方法
5. **零迁移成本**：FileProvider 读写同一批 `.md` 文件

## 验证

```bash
npx tsc --noEmit -p packages/memory/tsconfig.json
npx tsc --noEmit -p packages/agent/tsconfig.json
cd packages/memory && bun test test/
```
