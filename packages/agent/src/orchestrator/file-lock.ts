/**
 * FileLockManager：并行子 Agent 的文件级写锁。
 * ==========================================
 *
 * 解决的问题：多个 read_write 子 Agent（边牧/德牧/萨摩）并行时，
 * 只靠 prompt 约定「别改同一文件」，write/edit 竞争会静默丢更新
 * （write_file 原子写 → 后写覆盖先写；edit_file 读-改-写竞态）。
 *
 * 语义：
 * - 占用粒度 = 文件 × 子 Agent 运行期（child run 结束时 releaseAll）
 * - 先来先服务；后来的子 Agent 等待（wait），超时（denied）后该工具调用
 *   以冲突失败返回，由模型决定重试或改派
 * - 同一批目标按路径排序后原子获取，避免批次内顺序死锁；
 *   跨调用互等（A 持 X 要 Y、B 持 Y 要 X）由超时兜底打破
 * - 同一 owner 重复获取幂等（子 Agent 多轮改同一文件不阻塞自己）
 */

export interface FileLockAcquireResult {
  readonly ok: boolean;
  /** 冲突时：当前持有者（owner id，通常是子 Agent runId） */
  readonly holder?: string;
  /** 冲突时：被占用的路径 */
  readonly path?: string;
}

/** 归一化锁键：去 ./ 前缀、统一分隔符 */
export function normalizeLockPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export class FileLockManager {
  private readonly locks = new Map<string, string>();

  /** 非阻塞尝试：路径排序 + 全量原子获取 */
  tryAcquire(paths: readonly string[], owner: string): FileLockAcquireResult {
    const sorted = [...new Set(paths.map(normalizeLockPath))].sort();
    for (const p of sorted) {
      const holder = this.locks.get(p);
      if (holder !== undefined && holder !== owner) {
        return { ok: false, holder, path: p };
      }
    }
    for (const p of sorted) this.locks.set(p, owner);
    return { ok: true };
  }

  /**
   * 等待式获取：先非阻塞尝试；失败则轮询等待直到超时。
   * onWait 仅在首次冲突时回调一次（用于发等待事件，避免刷屏）。
   */
  async acquire(
    paths: readonly string[],
    owner: string,
    timeoutMs: number,
    onWait?: (conflict: FileLockAcquireResult) => void,
  ): Promise<FileLockAcquireResult> {
    const immediate = this.tryAcquire(paths, owner);
    if (immediate.ok) return immediate;
    onWait?.(immediate);
    const deadline = Date.now() + timeoutMs;
    let last: FileLockAcquireResult = immediate;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      last = this.tryAcquire(paths, owner);
      if (last.ok) return last;
    }
    return last;
  }

  /** 释放某个 owner 持有的全部锁（子 Agent run 结束时调用） */
  releaseAll(owner: string): void {
    for (const [p, o] of this.locks) {
      if (o === owner) this.locks.delete(p);
    }
  }

  holderOf(path: string): string | undefined {
    return this.locks.get(normalizeLockPath(path));
  }

  /** 当前持有的锁数量（测试/诊断用） */
  get size(): number {
    return this.locks.size;
  }
}
