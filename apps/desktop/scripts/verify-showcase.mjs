import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2] || "/Users/Zhuanz/Documents/CS/项目/paw-ts/paw-showcase";
const fails = [];
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) fails.push(name);
};

const files = [
  "index.html",
  "styles.css",
  "theme.js",
  "memory-demo.js",
  "README.md",
];
for (const f of files) ok(`file ${f}`, existsSync(join(dir, f)));

const html = readFileSync(join(dir, "index.html"), "utf8");
const css = readFileSync(join(dir, "styles.css"), "utf8");
const theme = readFileSync(join(dir, "theme.js"), "utf8");
const mem = readFileSync(join(dir, "memory-demo.js"), "utf8");

ok("html links styles.css", /styles\.css/.test(html));
ok("html loads theme.js", /theme\.js/.test(html));
ok("html loads memory-demo.js", /memory-demo\.js/.test(html));
ok("has nav", /navbar|nav/i.test(html));
ok("has hero", /hero/i.test(html));
ok("has capabilities", /长期记忆|多轮|Plan|Context|Memory/i.test(html));
ok("has faq", /faq|常见问题/i.test(html));
ok("has memory demo section", /memory-demo|记忆演示/i.test(html));
ok("has theme toggle button", /theme-toggle|切换.*色/i.test(html));
ok("theme uses localStorage", /localStorage/.test(theme));
ok("theme sets data-theme", /data-theme|setAttribute/.test(theme));
ok("mem has preference/decision", /preference/i.test(mem) && /decision/i.test(mem));
ok("mem has failure (round2)", /failure/i.test(mem));
ok("mem has filter logic", /filter|筛选|data-filter/i.test(html + mem));
ok("css blue accent #1a6bff", /#1a6bff|1a6bff/i.test(css + html));
ok("hero mentions long-term memory", /长期记忆|跨会话/i.test(html));

// relative assets exist
const refs = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
  .map((m) => m[1])
  .filter(
    (u) =>
      !u.startsWith("http") &&
      !u.startsWith("#") &&
      !u.startsWith("data:") &&
      !u.startsWith("mailto:"),
  );
for (const r of refs) {
  ok(`asset exists ${r}`, existsSync(join(dir, r)));
}

// Count fake memory items roughly
const prefCount = (mem.match(/type:\s*["']preference["']/g) || []).length;
const decCount = (mem.match(/type:\s*["']decision["']/g) || []).length;
const failCount = (mem.match(/type:\s*["']failure["']/g) || []).length;
ok(
  "memory items count >= 4",
  prefCount + decCount + failCount >= 4,
  `p=${prefCount} d=${decCount} f=${failCount}`,
);

// Basic JS parse check
try {
  new Function(theme);
  ok("theme.js parses", true);
} catch (e) {
  ok("theme.js parses", false, String(e.message));
}
try {
  new Function(mem);
  ok("memory-demo.js parses", true);
} catch (e) {
  ok("memory-demo.js parses", false, String(e.message));
}

console.log("\nfile:// URL:");
console.log(pathToFileURL(join(dir, "index.html")).href);
console.log(`\nResult: ${fails.length === 0 ? "ALL PASS" : fails.length + " FAIL"}`);
if (fails.length) {
  console.log("Failed:", fails.join(", "));
  process.exit(1);
}
