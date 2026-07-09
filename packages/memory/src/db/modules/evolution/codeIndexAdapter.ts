/**
 * Code Index Adapter (8.8)
 *
 * 封装代码索引基础设施，为 Memory Retriever / Governance 提供标准化查询接口。
 * 通过依赖注入接入现有 workspace/code-index，避免 packages/memory → workspace 硬依赖。
 *
 * MVP: 薄封装层，失败时返回空数组（降级，不阻塞记忆检索）。
 */

export interface CodeContextBlock {
  readonly path: string;
  readonly symbols: readonly string[];
  readonly tests: readonly string[];
  readonly reason: string;
}

export type CodeIndexQueryFn = (
  workspaceRoot: string,
  query: string,
  mentionedPaths?: readonly string[],
  limit?: number,
) => readonly CodeContextBlock[];

export interface CodeIndexRecord {
  id: string;
  repositoryId: string;
  branch: string;
  recordType: "file" | "symbol" | "reference";
  key: string;
  data: {
    filePath: string;
    symbols: readonly string[];
    tests: readonly string[];
    reason: string;
  };
  extractor: "filesystem";
  extractorVersion: string;
  indexedAt: string;
}

export interface CodeIndexQuery {
  repositoryId: string;
  branch?: string;
  query: string;
  mentionedPaths?: readonly string[];
  limit?: number;
}

export class CodeIndexAdapter {
  private queryFn: CodeIndexQueryFn | null;
  private workspaceRoot: string;

  constructor(workspaceRoot: string, queryFn?: CodeIndexQueryFn) {
    this.workspaceRoot = workspaceRoot;
    this.queryFn = queryFn ?? null;
  }

  setQueryFn(fn: CodeIndexQueryFn): void {
    this.queryFn = fn;
  }

  async query(req: CodeIndexQuery): Promise<CodeIndexRecord[]> {
    if (!this.queryFn) return [];
    try {
      const blocks = this.queryFn(this.workspaceRoot, req.query, req.mentionedPaths ?? [], req.limit ?? 10);
      return blocks.map((b, i) => this.toRecord(b, req, i));
    } catch {
      return [];
    }
  }

  async findByFile(req: CodeIndexQuery & { filePath: string }): Promise<CodeIndexRecord[]> {
    if (!this.queryFn) return [];
    try {
      const blocks = this.queryFn(this.workspaceRoot, req.filePath, [req.filePath], 5);
      return blocks.map((b, i) => this.toRecord(b, req, i));
    } catch {
      return [];
    }
  }

  isAvailable(): boolean {
    return this.queryFn !== null;
  }

  private toRecord(block: CodeContextBlock, req: CodeIndexQuery, i: number): CodeIndexRecord {
    return {
      id: `codeidx_${req.repositoryId}_${i}`,
      repositoryId: req.repositoryId,
      branch: req.branch ?? "main",
      recordType: block.symbols.length > 0 ? "symbol" : "file",
      key: block.path,
      data: { filePath: block.path, symbols: block.symbols, tests: block.tests, reason: block.reason },
      extractor: "filesystem",
      extractorVersion: "1.0",
      indexedAt: new Date().toISOString(),
    };
  }
}
