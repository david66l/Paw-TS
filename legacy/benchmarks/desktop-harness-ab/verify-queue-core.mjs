import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2]);
const results = [];
let Q;
const check = async (name, body) => {
  try {
    if (name !== "public module and test command")
      assert.equal(
        typeof Q,
        "function",
        "Required JobQueue module unavailable",
      );
    await body();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({
      name,
      pass: false,
      error: String(error.message).slice(0, 300),
    });
  }
};
await check("public module and test command", async () => {
  Q = (await import(pathToFileURL(path.join(root, "src/queue.js")))).JobQueue;
  assert.equal(typeof Q, "function");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(pkg.type, "module");
  assert.equal(typeof pkg.scripts?.test, "string");
  assert(pkg.scripts.test.trim());
});
await check("empty queue and missing id", () => {
  const q = new Q();
  assert.equal(q.dequeue(), null);
  assert.equal(q.get("missing"), null);
  assert.deepEqual(q.list(), []);
});
await check("unique string ids and initial fields", () => {
  const q = new Q();
  const jobs = Array.from({ length: 20 }, (_, n) => q.enqueue({ n }));
  assert.equal(new Set(jobs.map((j) => j.id)).size, 20);
  for (const j of jobs) {
    assert.equal(typeof j.id, "string");
    assert.equal(j.priority, 0);
    assert.equal(j.status, "pending");
    assert.equal(j.attempts, 0);
  }
});
await check("priority and FIFO", () => {
  const q = new Q();
  const a = q.enqueue("a", { priority: -1 });
  const b = q.enqueue("b", { priority: 2 });
  const c = q.enqueue("c", { priority: 2 });
  assert.deepEqual(
    [q.dequeue().id, q.dequeue().id, q.dequeue().id],
    [b.id, c.id, a.id],
  );
  assert.equal(q.dequeue(), null);
});
await check("dedupe preserves the existing job", () => {
  const q = new Q();
  const a = q.enqueue({ n: 1 }, { key: "same", priority: 1 });
  assert.deepEqual(q.enqueue({ n: 2 }, { key: "same", priority: 9 }), a);
  q.dequeue();
  assert.equal(q.enqueue("again", { key: "same" }).status, "running");
  assert.equal(q.list().length, 1);
});
await check("dequeue transition, enqueue order and status filter", () => {
  const q = new Q();
  const a = q.enqueue("a");
  const b = q.enqueue("b", { priority: 4 });
  const job = q.dequeue();
  assert.equal(job.id, b.id);
  assert.equal(job.status, "running");
  assert.equal(job.attempts, 1);
  assert.equal(q.get(b.id).attempts, 1);
  assert.deepEqual(
    q.list().map((j) => j.id),
    [a.id, b.id],
  );
  assert.deepEqual(
    q.list({ status: "pending" }).map((j) => j.id),
    [a.id],
  );
  assert.deepEqual(
    q.list({ status: "running" }).map((j) => j.id),
    [b.id],
  );
});
await check("returned nested state isolation", () => {
  const q = new Q();
  const original = q.enqueue({ nested: { value: 1 }, items: [{ value: 2 }] });
  const returned = [original, q.get(original.id), q.list()[0], q.dequeue()];
  for (const job of returned) {
    // Immutable returns and mutable defensive copies both satisfy the contract.
    try {
      job.payload.nested.value = 99;
    } catch {}
    try {
      job.payload.items[0].value = 99;
    } catch {}
    assert.deepEqual(q.get(original.id).payload, {
      nested: { value: 1 },
      items: [{ value: 2 }],
    });
  }
});
await check("invalid maxAttempts", () => {
  for (const maxAttempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => new Q({ maxAttempts }));
});
await check("nonfinite priority", () => {
  const q = new Q();
  for (const priority of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])
    assert.throws(() => q.enqueue("bad", { priority }));
  assert.equal(q.list().length, 0);
});
console.log(
  JSON.stringify(
    {
      task: "queue-core-stage-only",
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      results,
    },
    null,
    2,
  ),
);
