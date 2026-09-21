import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
// Model-only transport for a --network none benchmark container. No credentials.
import http from "node:http";
const spool = "/relay";
const effort = process.env.PAW_BENCH_EFFORT ?? "max";
if (!["high", "max"].includes(effort)) throw new Error("Invalid benchmark effort");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = http.createServer(async (req, res) => {
  const id = randomUUID();
  const prefix = `${spool}/${id}`;
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16_000_000) throw new Error("Request too large");
    }
    const headers = Object.fromEntries(
      ["anthropic-version", "anthropic-beta", "content-type"]
        .filter((k) => req.headers[k])
        .map((k) => [k, req.headers[k]]),
    );
    fs.writeFileSync(
      `${prefix}.tmp`,
      JSON.stringify({ method: req.method, url: req.url, headers, body }),
    );
    fs.renameSync(`${prefix}.tmp`, `${prefix}.request`);
    res.on("close", () => {
      if (!res.writableEnded) fs.writeFileSync(`${prefix}.cancel`, "");
    });
    while (!fs.existsSync(`${prefix}.meta`)) {
      if (res.destroyed) return;
      await delay(25);
    }
    const meta = JSON.parse(fs.readFileSync(`${prefix}.meta`, "utf8"));
    res.writeHead(meta.status, { "content-type": meta.contentType });
    let offset = 0;
    for (;;) {
      if (res.destroyed) return;
      const done = fs.existsSync(`${prefix}.done`);
      if (fs.existsSync(`${prefix}.body`)) {
        const size = fs.statSync(`${prefix}.body`).size;
        if (size > offset) {
          const fd = fs.openSync(`${prefix}.body`, "r");
          const data = Buffer.alloc(size - offset);
          const read = fs.readSync(fd, data, 0, data.length, offset);
          fs.closeSync(fd);
          offset += read;
          res.write(data.subarray(0, read));
        }
      }
      if (done) break;
      await delay(25);
    }
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end("Benchmark relay failed");
  }
});
server.listen(8787, "127.0.0.1", () => {
  fs.mkdirSync("/tmp/zcode-home/.zcode/cli", { recursive: true });
  fs.writeFileSync(
    "/tmp/zcode-home/.zcode/cli/config.json",
    JSON.stringify({
      model: { main: "bench/glm-5.3-flash", lite: "bench/glm-5.3-flash" },
      provider: {
        bench: {
          kind: "anthropic",
          name: "BigModel benchmark relay",
          options: {
            baseURL: "http://127.0.0.1:8787",
            apiKey: "benchmark-relay-placeholder",
            apiKeyRequired: true,
          },
          models: {
            "glm-5.3-flash": {
              name: "GLM-5.3-Flash",
              contextWindow: 1000000,
              maxOutputTokens: 128000,
              supportsToolCall: true,
              reasoning: {
                enabled: true,
                levels: [effort],
                defaultLevel: effort,
                providerOptionsByLevel: {
                  [effort]: {
                    anthropic: {
                      effort,
                      thinking: { type: "enabled", budgetTokens: 32000 },
                    },
                  },
                },
              },
            },
          },
        },
      },
      storage: {
        dir: "/zcode-state",
        sessionDbPath: "/zcode-state/cli/db/db.sqlite",
      },
      features: {
        subagent: false,
        memory: false,
        skill: false,
        mcp: false,
        compact: true,
        rewind: true,
      },
      memory: { use: false },
      plugins: { enabled: false },
      skills: { enabled: false },
      permission: { mode: "yolo" },
      ui: { locale: "en-US" },
    }),
  );
  const child = spawn(
    "node",
    ["/opt/zcode/zcode.cjs", ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, ZCODE_MODEL_TELEMETRY_ENABLED: "0" },
    },
  );
  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});
