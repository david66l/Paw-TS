// Model-only transport for a --network none benchmark container. No credentials.
import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
const spool = "/relay";
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
  const child = spawn("claude", process.argv.slice(2), {
    stdio: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_API_KEY: "benchmark-relay-placeholder",
    },
  });
  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});
