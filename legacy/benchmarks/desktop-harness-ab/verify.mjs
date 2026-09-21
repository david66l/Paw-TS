import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const [kind, workspace] = process.argv.slice(2);
const results = [];
let publicGuard = () => true;
const check = async (name, body) => {
  try {
    if (name !== "public modules" && name !== "README and test command")
      assert(publicGuard(name), "Required public interface unavailable");
    await body();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: String(e.message).slice(0, 500) });
  }
};
const mod = (file) => import(pathToFileURL(path.join(workspace, file)).href);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ab-verifier-"));
const cli = (...args) => {
  assert(
    fs.existsSync(path.join(workspace, "src/cli.js")),
    "CLI entry point missing",
  );
  return spawnSync(
    process.execPath,
    [path.join(workspace, "src/cli.js"), ...args],
    {
      encoding: "utf8",
      timeout: 10000,
      cwd: workspace,
    },
  );
};
try {
  if (kind === "queue") {
    let Q, save, load;
    publicGuard = (name) =>
      name.startsWith("CLI")
        ? fs.existsSync(path.join(workspace, "src/cli.js"))
        : typeof Q === "function" &&
          (name !== "disk persistence" ||
            (typeof save === "function" && typeof load === "function"));
    await check("public modules", async () => {
      Q = (await mod("src/queue.js").catch(() => ({}))).JobQueue;
      const s = await mod("src/store.js").catch(() => ({}));
      save = s.saveQueue;
      load = s.loadQueue;
      assert.equal(typeof Q, "function");
      assert.equal(typeof save, "function");
      assert.equal(typeof load, "function");
    });
    await check("priority and FIFO", () => {
      const q = new Q();
      const a = q.enqueue("a"),
        b = q.enqueue("b", { priority: 2 }),
        c = q.enqueue("c", { priority: 2 });
      assert.equal(q.dequeue().id, b.id);
      assert.equal(q.dequeue().id, c.id);
      assert.equal(q.dequeue().id, a.id);
      assert.equal(q.dequeue(), null);
    });
    await check("running and completion", () => {
      const q = new Q();
      const a = q.enqueue({ x: 1 });
      assert.equal(a.status, "pending");
      assert.equal(a.attempts, 0);
      q.dequeue();
      assert.equal(q.get(a.id).status, "running");
      q.complete(a.id, { done: true });
      assert.deepEqual(q.get(a.id).result, { done: true });
      assert.equal(q.get(a.id).status, "completed");
    });
    await check("dedupe after completion", () => {
      const q = new Q();
      const a = q.enqueue("a", { key: "k" });
      q.dequeue();
      q.complete(a.id, 1);
      assert.equal(q.enqueue("b", { key: "k" }).id, a.id);
      assert.equal(q.list().length, 1);
    });
    await check("retry limit", () => {
      const q = new Q({ maxAttempts: 2 });
      const a = q.enqueue("a");
      q.dequeue();
      q.fail(a.id, "one");
      assert.equal(q.get(a.id).status, "pending");
      assert.equal(q.dequeue().attempts, 2);
      q.fail(a.id, "two");
      assert.equal(q.get(a.id).status, "failed");
      assert.equal(q.get(a.id).error, "two");
      assert.equal(q.dequeue(), null);
    });
    await check("invalid transitions", () => {
      const q = new Q();
      const a = q.enqueue(1);
      assert.throws(() => q.complete(a.id, 1));
      assert.throws(() => q.fail(a.id, "x"));
      assert.throws(() => q.complete("missing", 1));
      assert.equal(q.get("missing"), null);
    });
    await check("option validation", () => {
      for (const x of [0, -1, 1.5])
        assert.throws(() => new Q({ maxAttempts: x }));
      assert.throws(() => new Q().enqueue(1, { priority: Infinity }));
    });
    await check("nested state isolation", () => {
      const q = new Q();
      const p = { nested: { v: 1 } };
      const a = q.enqueue(p);
      p.nested.v = 2;
      a.payload.nested.v = 3;
      q.get(a.id).payload.nested.v = 4;
      assert.equal(q.get(a.id).payload.nested.v, 1);
      const result = { v: { x: 1 } };
      q.dequeue();
      q.complete(a.id, result);
      result.v.x = 2;
      q.list()[0].result.v.x = 3;
      assert.equal(q.get(a.id).result.v.x, 1);
    });
    await check("status filtering", () => {
      const q = new Q();
      q.enqueue(1);
      q.enqueue(2);
      q.dequeue();
      assert.equal(q.list({ status: "pending" }).length, 1);
      assert.equal(q.list({ status: "running" }).length, 1);
    });
    await check("snapshot recovery", () => {
      const q = new Q({ maxAttempts: 2 });
      const a = q.enqueue(1, { key: "k" });
      q.dequeue();
      const r = Q.restore(JSON.parse(JSON.stringify(q.snapshot())));
      assert.equal(r.get(a.id).status, "pending");
      assert.equal(r.get(a.id).attempts, 1);
      assert.equal(r.enqueue(2, { key: "k" }).id, a.id);
      assert.notEqual(r.enqueue(3).id, a.id);
      r.dequeue();
      r.fail(a.id, "end");
      assert.equal(r.get(a.id).status, "failed");
    });
    await check("invalid snapshot rejected", () => {
      for (const s of [null, {}, { jobs: "broken" }])
        assert.throws(() => Q.restore(s));
    });
    await check("disk persistence", async () => {
      const file = path.join(temp, "nested/q.json");
      const q = new Q();
      const a = q.enqueue({ hello: 1 });
      await save(file, q);
      const r = await load(file);
      assert.deepEqual(r.get(a.id).payload, { hello: 1 });
      assert.deepEqual(
        (await load(path.join(temp, "missing.json"))).list(),
        [],
      );
      fs.writeFileSync(file, "{");
      await assert.rejects(async () => load(file));
    });
    await check("CLI add/list/next persistence", () => {
      const file = path.join(temp, "cli.json");
      let r = cli(file, "add", '{"hello":1}', "4");
      assert.equal(r.status, 0, r.stderr);
      const a = JSON.parse(r.stdout);
      r = cli(file, "list");
      assert.equal(JSON.parse(r.stdout)[0].id, a.id);
      r = cli(file, "next");
      assert.equal(JSON.parse(r.stdout).id, a.id);
      assert.equal(JSON.parse(r.stdout).status, "running");
    });
    await check("CLI invalid input", () => {
      const r = cli(path.join(temp, "bad.json"), "add", "{");
      assert.notEqual(r.status, 0);
      assert(r.stderr.trim());
    });
  } else {
    let parse, normalize, summarize, total;
    publicGuard = (name) => {
      if (name.startsWith("CLI"))
        return fs.existsSync(path.join(workspace, "src/cli.js"));
      if (name.startsWith("CSV")) return typeof parse === "function";
      if (name === "legacy total preserved") return typeof total === "function";
      if (
        [
          "currency totals and grouped order",
          "inclusive date filter",
          "filter rejection and empty result",
        ].includes(name)
      )
        return (
          typeof normalize === "function" && typeof summarize === "function"
        );
      return typeof normalize === "function";
    };
    const row = (over = {}) => ({
      id: "1",
      date: "2024-02-29",
      category: "food",
      amount: "0.10",
      currency: "CNY",
      ...over,
    });
    await check("public modules", async () => {
      parse = (await mod("src/csv.js").catch(() => ({}))).parseCsv;
      ({
        normalizeTransactions: normalize,
        summarize,
        total,
      } = await mod("src/ledger.js").catch(() => ({})));
      for (const x of [parse, normalize, summarize, total])
        assert.equal(typeof x, "function");
    });
    await check("CSV BOM quotes CRLF", () => {
      assert.deepEqual(
        parse('\uFEFFid,note\r\n1,"a,b"\r\n2,"say ""hi"""\r\n'),
        [
          { id: "1", note: "a,b" },
          { id: "2", note: 'say "hi"' },
        ],
      );
    });
    await check("CSV multiline and blank lines", () => {
      assert.deepEqual(parse('id,note\n\n1,"a\nb"\n\n'), [
        { id: "1", note: "a\nb" },
      ]);
      assert.deepEqual(parse(" \r\n"), []);
    });
    await check("CSV malformed rejects", () => {
      for (const t of ["a,a\n1,2", "a,b\n1", 'a\n"open', "a\n1,2"])
        assert.throws(() => parse(t));
    });
    await check("exact cents trim and negatives", () => {
      const input = [
        row({ id: " 1 ", amount: " 0.29 ", currency: " CNY " }),
        row({ id: "2", amount: "-10.05" }),
      ];
      const before = JSON.stringify(input);
      const n = normalize(input);
      assert.equal(n[0].amountCents, 29);
      assert.equal(n[1].amountCents, -1005);
      assert.equal(n[0].id, "1");
      assert.equal(JSON.stringify(input), before);
    });
    await check("amount format rejection", () => {
      for (const amount of ["1e2", "1.001", "", "NaN", "9007199254740992.00"])
        assert.throws(() => normalize([row({ amount })]));
    });
    await check("calendar validation", () => {
      for (const date of [
        "2023-02-29",
        "2024-02-30",
        "2024-13-01",
        "2024-1-01",
      ])
        assert.throws(() => normalize([row({ date })]));
      assert.equal(normalize([row()])[0].date, "2024-02-29");
    });
    await check("identity and currency validation", () => {
      assert.throws(() => normalize([row(), row()]));
      for (const over of [{ id: " " }, { category: " " }, { currency: "EUR" }])
        assert.throws(() => normalize([row(over)]));
    });
    const sample = () =>
      normalize([
        row(),
        row({ id: "2", amount: "0.20" }),
        row({
          id: "3",
          category: "books",
          amount: "-1.00",
          currency: "USD",
          date: "2024-03-01",
        }),
        row({ id: "4", category: "food", amount: "2.00", currency: "USD" }),
      ]);
    await check("currency totals and grouped order", () => {
      const s = summarize(sample());
      assert.deepEqual(s, {
        count: 4,
        totals: { CNY: 30, USD: 100 },
        byCategory: [
          { category: "books", currency: "USD", amountCents: -100, count: 1 },
          { category: "food", currency: "CNY", amountCents: 30, count: 2 },
          { category: "food", currency: "USD", amountCents: 200, count: 1 },
        ],
      });
    });
    await check("inclusive date filter", () => {
      const s = summarize(sample(), { from: "2024-02-29", to: "2024-02-29" });
      assert.equal(s.count, 3);
      assert.deepEqual(s.totals, { CNY: 30, USD: 200 });
    });
    await check("filter rejection and empty result", () => {
      assert.throws(() =>
        summarize(sample(), { from: "2024-03-01", to: "2024-02-29" }),
      );
      assert.throws(() => summarize(sample(), { to: "2024-02-30" }));
      assert.deepEqual(summarize([]), {
        count: 0,
        totals: { CNY: 0, USD: 0 },
        byCategory: [],
      });
    });
    await check("legacy total preserved", () => {
      assert.equal(total([{ amount: "1.25" }, { amount: "-0.25" }]), 1);
    });
    await check("CLI report", () => {
      const f = path.join(temp, "input.csv");
      fs.writeFileSync(
        f,
        "id,date,category,amount,currency\n1,2024-02-29,food,0.29,CNY\n",
      );
      const r = cli("report", f, "--from", "2024-02-29");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).totals.CNY, 29);
    });
    await check("CLI flag/error handling", () => {
      for (const args of [
        ["report"],
        ["report", "missing.csv"],
        ["report", "missing.csv", "--wat"],
      ]) {
        const r = cli(...args);
        assert.notEqual(r.status, 0);
        assert(r.stderr.trim());
      }
    });
  }
  await check("README and test command", () => {
    assert(
      fs.readFileSync(path.join(workspace, "README.md"), "utf8").trim().length >
        80,
    );
    const p = JSON.parse(
      fs.readFileSync(path.join(workspace, "package.json"), "utf8"),
    );
    assert.equal(p.type, "module");
    assert(p.scripts?.test);
  });
  console.log(
    JSON.stringify({
      passed: results.filter((x) => x.pass).length,
      total: results.length,
      checks: results,
    }),
  );
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith("paw-ab-verifier-"));
  fs.rmSync(temp, { recursive: true, force: true });
}
