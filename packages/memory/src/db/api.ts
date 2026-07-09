/**
 * HTTP API (Ch10)
 *
 * REST 接口，对外暴露记忆系统能力。薄路由层，业务逻辑全量委托给已有模块。
 * 启动: bun run packages/memory/src/db/api.ts
 * 端口: MEMORY_API_PORT 环境变量（默认 3300）
 */

import {
  TaskSessionManager, WorkingMemoryManager,
  MemoryWriter, MemoryRetriever, ContextBuilder,
  PolicyEngine, admin,
} from "./modules/index.js";
import type { MemoryType } from "./types.js";
import { memoryItemDao } from "./dao/memoryItem.js";
import { ping as dbPing } from "./connection.js";
import { obs } from "./modules/platform/observability.js";

// ── Bootstrap ──

const engine = new PolicyEngine();
const taskMgr = new TaskSessionManager(engine);
const wmMgr = new WorkingMemoryManager();
const writer = new MemoryWriter(engine);
const retriever = new MemoryRetriever(engine);
const ctxBuilder = new ContextBuilder(engine);

// ── Helpers ──

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { return await req.json() as Record<string, unknown>; }
  catch { return {}; }
}

// ── Router ──

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    // Health
    if (path === "/health" && method === "GET") {
      const dbOk = await dbPing();
      return json({ status: dbOk ? "ok" : "degraded", db: dbOk });
    }

    // TaskSession
    if (path === "/tasks" && method === "POST") {
      const body = await readBody(req);
      const { task } = await taskMgr.createTask({
        userId: body.userId as string,
        repositoryId: body.repositoryId as string,
        workspaceId: body.workspaceId as string,
        initialUserRequest: body.initialUserRequest as string,
        title: body.title as string,
      });
      return json({ task }, 201);
    }
    if (path.startsWith("/tasks/") && method === "GET") {
      const id = path.split("/")[2]!;
      const task = await taskMgr.getTask(id);
      if (!task) return json({ error: "not found" }, 404);
      const wm = await wmMgr.getByTaskId(id);
      return json({ task, workingMemory: wm });
    }
    if (path.startsWith("/tasks/") && path.endsWith("/start") && method === "POST") {
      const id = path.split("/")[2]!;
      const task = await taskMgr.getTask(id);
      if (!task) return json({ error: "not found" }, 404);
      const started = await taskMgr.startTask(id, task.revision);
      return json({ task: started });
    }
    if (path.startsWith("/tasks/") && path.endsWith("/complete") && method === "POST") {
      const id = path.split("/")[2]!;
      const task = await taskMgr.getTask(id);
      if (!task) return json({ error: "not found" }, 404);
      const completed = await taskMgr.completeTask(id, task.revision);

      // Auto-write candidates
      const fw = await wmMgr.getByTaskId(id);
      if (fw) {
        await writer.writeFromFinalSnapshot({
          taskId: id, workingMemory: fw,
          repositoryId: task.repositoryId, userId: task.userId,
        });
      }
      return json({ task: completed, candidatesGenerated: true });
    }

    // MemoryItem
    if (path === "/memories" && method === "POST") {
      const body = await readBody(req);
      const now = new Date().toISOString();
      const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const item = {
        id, schemaVersion: 1,
        type: (body.type as string) ?? "project_knowledge",
        subjectKey: (body.subjectKey as string) ?? `manual:${id}`,
        subjectKeyVersion: 1,
        title: (body.title as string) ?? "",
        summary: (body.summary as string) ?? "",
        status: "active",
        scope: { repositoryId: body.repositoryId, userId: body.userId },
        confidence: (body.confidence as number) ?? 0.8,
        verificationStatus: "verified",
        payload: (body.payload as Record<string, unknown>) ?? {},
        tags: (body.tags as string[]) ?? [],
        relatedFiles: [], relatedSymbols: [], relatedTestRunIds: [],
        sensitivity: "internal", version: 1,
        createdBy: { actorType: "user", actorId: body.userId as string ?? "api" },
        updatedBy: { actorType: "user", actorId: body.userId as string ?? "api" },
        createdAt: now, updatedAt: now,
      } as any;
      await memoryItemDao.create(item);
      return json({ memory: item }, 201);
    }
    if (path === "/memories" && method === "GET") {
      const url = new URL(req.url);
      const items = await memoryItemDao.query({
        type: (url.searchParams.get("type") as MemoryType) ?? undefined,
        status: "active",
        scopeRepoId: url.searchParams.get("repositoryId") ?? undefined,
        limit: parseInt(url.searchParams.get("limit") ?? "20"),
      });
      return json({ items, total: items.length });
    }
    if (path.startsWith("/memories/retrieve") && method === "POST") {
      const body = await readBody(req);
      const result = await retriever.retrieve({
        taskId: (body.taskId as string) ?? "api",
        repositoryId: body.repositoryId as string,
        userId: body.userId as string,
        query: (body.query as string) ?? "",
        types: body.types as MemoryType[],
        limit: body.limit as number,
      });
      return json(result);
    }

    // Context
    if (path === "/context/build" && method === "POST") {
      const body = await readBody(req);
      const wm = body.taskId ? await wmMgr.getByTaskId(body.taskId as string) : null;
      if (!wm) return badRequest("taskId required for working memory context");

      const retrieval = body.query
        ? await retriever.retrieve({ taskId: body.taskId as string, repositoryId: body.repositoryId as string, query: body.query as string, limit: 10 })
        : undefined;

      const ctx = ctxBuilder.build({
        workingMemory: wm,
        retrievalResult: retrieval,
        currentUserRequest: body.currentUserRequest as string ?? "",
        tokenBudget: (body.tokenBudget as number) ?? engine.getDefaults().context.tokenBudget.availableForContext,
      });
      return json(ctx);
    }

    // Admin
    if (path === "/candidates" && method === "GET") {
      const url = new URL(req.url);
      const list = await admin.listPendingCandidates(parseInt(url.searchParams.get("limit") ?? "20"));
      return json({ candidates: list, total: list.length });
    }
    if (path.startsWith("/candidates/") && path.endsWith("/approve") && method === "POST") {
      const id = path.split("/")[2]!;
      const result = await admin.approveCandidate(id);
      return json(result);
    }
    if (path.startsWith("/candidates/") && path.endsWith("/reject") && method === "POST") {
      const id = path.split("/")[2]!;
      const body = await readBody(req);
      const decision = await admin.rejectCandidate(id, (body.reason as string) ?? "Rejected via API");
      return json({ decision });
    }

    // Stats
    if (path === "/stats" && method === "GET") {
      const s = await admin.stats();
      return json(s);
    }

    // Health detail
    if (path === "/health/detail" && method === "GET") {
      const dbOk = await dbPing();
      return json({ status: dbOk ? "ok" : "degraded", db: dbOk, uptime: process.uptime(), metrics: obs.snapshot() });
    }

    // Task attempts
    if (path.match(/^\/tasks\/([^/]+)\/attempts$/) && method === "GET") {
      const taskId = path.split("/")[2]!;
      const sql = (await import("./connection.js")).getSql();
      const rows = await sql`SELECT * FROM task_execution_attempts WHERE task_id = ${taskId} ORDER BY attempt_number`;
      return json({ attempts: rows, total: rows.length });
    }
    if (path.match(/^\/tasks\/([^/]+)\/retry$/) && method === "POST") {
      const taskId = path.split("/")[2]!;
      const sql = (await import("./connection.js")).getSql();
      const max = await sql`SELECT COALESCE(MAX(attempt_number),0)+1 AS n FROM task_execution_attempts WHERE task_id = ${taskId}`;
      const id = `att_${Date.now().toString(36)}`;
      await sql`INSERT INTO task_execution_attempts (id, task_id, attempt_number, attempt_reason, status, started_at) VALUES (${id}, ${taskId}, ${Number(max[0]!.n)}, 'retry', 'running', now())`;
      obs.count("api.task.retry");
      return json({ attemptId: id, number: Number(max[0]!.n) }, 201);
    }

    // Memory versions
    if (path.match(/^\/memories\/([^/]+)\/versions$/) && method === "GET") {
      const id = path.split("/")[2]!;
      const versions = await memoryItemDao.listVersions(id);
      return json({ versions, total: versions.length });
    }
    if (path.match(/^\/memories\/([^/]+)$/) && method === "PUT") {
      const id = path.split("/")[2]!;
      const body = await readBody(req);
      const existing = await memoryItemDao.findById(id);
      if (!existing) return json({ error: "not found" }, 404);
      const updated = await memoryItemDao.update(id, existing.version, {
        title: body.title as string, summary: body.summary as string,
        confidence: body.confidence as number, tags: body.tags as string[],
        payload: body.payload as Record<string, unknown>,
      });
      obs.count("api.memory.update");
      return updated ? json({ memory: updated }) : json({ error: "version conflict" }, 409);
    }
    if (path.match(/^\/memories\/([^/]+)$/) && method === "DELETE") {
      const id = path.split("/")[2]!;
      const existing = await memoryItemDao.findById(id);
      if (!existing) return json({ error: "not found" }, 404);
      await memoryItemDao.update(id, existing.version, { status: "deleted" });
      obs.count("api.memory.delete");
      return json({ deleted: id });
    }
    if (path === "/memories/batch" && method === "POST") {
      const body = await readBody(req);
      const ids = body.ids as string[];
      if (!ids?.length) return badRequest("ids required");
      const results = [];
      for (const id of ids) {
        const item = await memoryItemDao.findById(id);
        results.push(item ? { id, found: true, type: item.type } : { id, found: false });
      }
      obs.count("api.memory.batch", ids.length);
      return json({ results });
    }

    // Admin detail
    if (path.match(/^\/admin\/decisions\/([^/]+)$/) && method === "GET") {
      const id = path.split("/")[3]!;
      const { governanceDecisionDao } = await import("./dao/governanceDecision.js");
      const d = await governanceDecisionDao.findById(id);
      return d ? json({ decision: d }) : json({ error: "not found" }, 404);
    }
    if (path === "/admin/candidates/stats" && method === "GET") {
      const all = await admin.listPendingCandidates(1000);
      const byType: Record<string, number> = {};
      for (const c of all) byType[c.proposedType] = (byType[c.proposedType] ?? 0) + 1;
      return json({ totalPending: all.length, byType });
    }

    obs.count("api.request");
    return json({ error: "not found" }, 404);
  } catch (err: any) {
    obs.log({ level: "ERROR", event: "api.error", module: "api", message: err?.message ?? String(err) });
    return json({ error: String(err) }, 500);
  }
}

// ── Start ──

const port = parseInt(process.env.MEMORY_API_PORT ?? "3300");
Bun.serve({ port, fetch: handle });
console.log(`Memory API running on http://localhost:${port}`);
