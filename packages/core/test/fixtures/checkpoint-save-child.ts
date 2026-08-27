import fs from "node:fs";

import { saveCheckpoint } from "../../src/checkpoint.js";

const [root, ready, barrier, label] = process.argv.slice(2);
if (!root || !ready || !barrier || !label) {
  throw new Error("checkpoint child requires root, ready, barrier and label");
}

fs.writeFileSync(ready, "ready", "utf8");
while (!fs.existsSync(barrier)) {
  await Bun.sleep(2);
}

try {
  saveCheckpoint(root, "concurrent-run", 1, "workspace.run_shell", {
    command: `echo ${label}`,
  });
  process.stdout.write(JSON.stringify({ status: "saved", label }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      status: "rejected",
      label,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
