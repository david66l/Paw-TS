/**
 * Profile 画像写入（spec §4.2 / §7.3 / §12.3）
 *
 * 纯函数 + 内存引擎，不依赖 Postgres。
 */

import { describe, test, expect } from "bun:test";
import type {
  LedgerEntry,
  MemoryEntry,
  MemoryFilter,
  MemoryStoreEngine,
  ProfileInsight,
  ReindexReport,
  ScoredId,
} from "../src/longterm/store/engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import {
  PROFILE_CAP,
  PROFILE_MIN_SUPPORT,
  admitProfile,
  enforceProfileCapacity,
  isBehaviorDescription,
  profileSimilarity,
  validateProfileDraft,
  type ProfileDraft,
} from "../src/longterm/write/profile.js";

/** 最小内存引擎：只实现 put/get/invalidate/query */
function makeMemEngine(): MemoryStoreEngine & { store: Map<string, MemoryEntry> } {
  const store = new Map<string, MemoryEntry>();
  return {
    store,
    async put(entry) {
      const id = entry.id || deriveEntryId(entry);
      store.set(id, { ...entry, id });
    },
    async get(id) {
      return store.get(id) ?? null;
    },
    async invalidate(id, tInvalid) {
      const e = store.get(id);
      if (e) store.set(id, { ...e, tInvalid });
    },
    async delete(id) {
      store.delete(id);
    },
    async query(filter: MemoryFilter) {
      let rows = [...store.values()];
      if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
      if (filter.repo) rows = rows.filter((e) => e.repo === filter.repo);
      if (!filter.includeInvalidated) rows = rows.filter((e) => e.tInvalid == null);
      return rows.slice(0, filter.limit ?? 200);
    },
    async searchText(): Promise<ScoredId[]> {
      return [];
    },
    async searchVector(): Promise<ScoredId[]> {
      return [];
    },
    async ledger(): Promise<LedgerEntry | null> {
      return null;
    },
    async bumpLedger(): Promise<void> {},
    async reindex(): Promise<ReindexReport> {
      return { scanned: 0, indexed: 0, failed: 0, smoke: { total: 0, passed: 0, failedIds: [] } };
    },
  };
}

function draft(overrides: Partial<ProfileDraft> & { insight: string }): ProfileDraft {
  return {
    repo: "repo-profile-test",
    evidence: ["runs/a/trajectory#1", "runs/b/trajectory#1", "runs/c/trajectory#1"],
    ...overrides,
  };
}

describe("isBehaviorDescription / validateProfileDraft", () => {
  test("拒绝空洞形容词", () => {
    expect(isBehaviorDescription("很谨慎")).toBe(false);
    expect(isBehaviorDescription("is cautious")).toBe(false);
    expect(isBehaviorDescription("提交前必跑完整测试套件")).toBe(true);
  });

  test(`证据不足 ${PROFILE_MIN_SUPPORT} 条 → reject`, () => {
    const r = validateProfileDraft(
      draft({ insight: "提交前必跑完整测试套件", evidence: ["a", "b"] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(`evidence_below_${PROFILE_MIN_SUPPORT}`);
  });

  test("证据去重后仍 ≥3 → ok", () => {
    const r = validateProfileDraft(
      draft({
        insight: "改完配置先跑 smoke 再合入",
        evidence: ["a", "b", "a", "c"],
      }),
    );
    expect(r).toEqual({ ok: true, supportCount: 3 });
  });
});

describe("profileSimilarity", () => {
  test("共享 ≥2 长特征词有命中", () => {
    expect(
      profileSimilarity(
        "提交前必跑完整测试套件再合入",
        "合入前必跑完整测试套件",
      ),
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("admitProfile", () => {
  test("证据够 → ADD", async () => {
    const engine = makeMemEngine();
    const r = await admitProfile(
      draft({ insight: "提交前必跑完整测试套件再合入" }),
      { engine, runId: "profile-add" },
    );
    expect(r.status).toBe("written");
    if (r.status === "written") {
      expect(r.op).toBe("ADD");
      const got = await engine.get(r.memoryId);
      expect(got?.kind).toBe("profile");
      if (got?.kind === "profile") {
        expect(got.supportCount).toBeGreaterThanOrEqual(3);
        expect(got.evidence).toHaveLength(3);
      }
    }
  });

  test("同主题 → EDIT 合并证据，不占新名额", async () => {
    const engine = makeMemEngine();
    const first = await admitProfile(
      draft({
        insight: "提交前必跑完整测试套件再合入",
        evidence: ["e1", "e2", "e3"],
      }),
      { engine },
    );
    expect(first.status).toBe("written");
    const second = await admitProfile(
      draft({
        insight: "合入前必跑完整测试套件并看覆盖率",
        evidence: ["e4", "e5", "e6"],
      }),
      { engine },
    );
    expect(second.status).toBe("edited");
    if (second.status === "edited" && first.status === "written") {
      expect(second.memoryId).toBe(first.memoryId);
      const got = (await engine.get(second.memoryId)) as ProfileInsight;
      expect(got.evidence.length).toBeGreaterThanOrEqual(4);
      const active = await engine.query({ kind: "profile", repo: "repo-profile-test" });
      expect(active).toHaveLength(1);
    }
  });

  test("证据不足 → rejected", async () => {
    const engine = makeMemEngine();
    const r = await admitProfile(
      draft({ insight: "提交前必跑完整测试", evidence: ["only-one"] }),
      { engine },
    );
    expect(r).toEqual({ status: "rejected", reason: "evidence_below_3" });
    expect(engine.store.size).toBe(0);
  });

  test(`满 ${PROFILE_CAP} 时 REMOVE 最低效用再 ADD`, async () => {
    const engine = makeMemEngine();
    const now = () => new Date("2026-08-10T00:00:00.000Z");
    // 每条 insight 主题正交，避免词面重叠触发误 EDIT
    const insights = [
      "Commit only after green unit suite finishes locally",
      "Open pull requests with checklist of changed modules",
      "Keep dependency pins exact inside lockfiles forever",
      "Document public APIs using typedoc style comments",
      "Prefer bun over npm when installing package tooling",
      "Squash fixup commits before requesting code review",
      "Never force push shared branches used by teammates",
      "Store secrets exclusively inside vault references",
      "Run database migrations behind feature flag gates",
      "Shadow deploy canaries prior to full production cut",
      "Capture failure trajectories into episodic lessons",
      "Invalidate stale facts rather than deleting rows",
      "Budget prompt tokens separately for each memory kind",
      "Reject adjective-only profile drafts lacking verbs",
      "Graduate trial lessons after verified task success",
    ];
    for (let i = 0; i < PROFILE_CAP; i++) {
      const r = await admitProfile(
        draft({
          insight: insights[i]!,
          evidence: [`r${i}a`, `r${i}b`, `r${i}c`],
        }),
        { engine, cap: PROFILE_CAP, now },
      );
      expect(r.status).toBe("written");
      if (r.status === "written") {
        const e = (await engine.get(r.memoryId)) as ProfileInsight;
        await engine.put({ ...e, utility: i, freq: 1 });
      }
    }
    const before = await engine.query({ kind: "profile", repo: "repo-profile-test" });
    expect(before).toHaveLength(PROFILE_CAP);

    const r = await admitProfile(
      draft({
        insight: "Inspect changelog and bump semver tags on every release",
        evidence: ["nx1", "nx2", "nx3"],
      }),
      { engine, cap: PROFILE_CAP, now },
    );
    expect(r.status).toBe("written");
    if (r.status === "written") {
      expect(r.removedId).toBeTruthy();
      const victim = await engine.get(r.removedId!);
      expect(victim?.tInvalid).not.toBeNull();
      const active = await engine.query({ kind: "profile", repo: "repo-profile-test" });
      expect(active).toHaveLength(PROFILE_CAP);
      expect(active.some((e) => e.id === r.memoryId)).toBe(true);
    }
  });

  test("满员且全是 user_statement → profile_cap_no_removable", async () => {
    const engine = makeMemEngine();
    for (let i = 0; i < 2; i++) {
      const r = await admitProfile(
        draft({
          insight:
            i === 0
              ? "Always execute bun test inside the package directory"
              : "Require signed commits from every contributor identity",
          evidence: [`u${i}a`, `u${i}b`, `u${i}c`],
          source: "user_statement",
        }),
        { engine, cap: 2 },
      );
      expect(r.status).toBe("written");
    }
    const r = await admitProfile(
      draft({
        insight: "Rebase onto mainline before opening any pull request",
        evidence: ["v1", "v2", "v3"],
        source: "agent_inferred",
      }),
      { engine, cap: 2 },
    );
    expect(r).toEqual({ status: "rejected", reason: "profile_cap_no_removable" });
  });
});

describe("enforceProfileCapacity", () => {
  test("超 cap 软失效效用最低者，user_statement 豁免", async () => {
    const engine = makeMemEngine();
    const now = () => new Date("2026-08-10T12:00:00.000Z");
    const ids: string[] = [];
    const insights = [
      "User insists on conventional commit message prefixes",
      "Nightly eslint autofix keeps the tree tidy",
      "Cache docker layers carefully during image builds",
      "Trim unused exports during weekly hygiene sweeps",
    ];
    for (let i = 0; i < 4; i++) {
      const r = await admitProfile(
        draft({
          insight: insights[i]!,
          evidence: [`c${i}a`, `c${i}b`, `c${i}c`],
          source: i === 0 ? "user_statement" : "agent_inferred",
        }),
        { engine, cap: 10, now },
      );
      expect(r.status).toBe("written");
      if (r.status === "written") {
        ids.push(r.memoryId);
        const e = (await engine.get(r.memoryId)) as ProfileInsight;
        await engine.put({ ...e, utility: i === 0 ? 99 : i, freq: 1 });
      }
    }
    const removed = await enforceProfileCapacity(engine, {
      repo: "repo-profile-test",
      cap: 2,
      now,
    });
    expect(removed.length).toBe(2);
    expect(removed).not.toContain(ids[0]); // user_statement 豁免
    const active = await engine.query({ kind: "profile", repo: "repo-profile-test" });
    expect(active).toHaveLength(2);
    expect(active.some((e) => e.id === ids[0])).toBe(true);
  });
});
