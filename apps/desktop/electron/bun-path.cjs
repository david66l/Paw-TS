const fs = require("node:fs");
const path = require("node:path");

/** Resolve native Bun binaries; npm's PowerShell shim cannot be spawned by Node. */
function findBun({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (env.BUN_PATH && exists(env.BUN_PATH)) return env.BUN_PATH;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const home = windows ? env.USERPROFILE || env.HOME : env.HOME;
  const candidates = [
    ...(home ? [paths.join(home, ".bun", "bin", windows ? "bun.exe" : "bun")] : []),
    ...(windows && env.APPDATA
      ? [paths.join(env.APPDATA, "npm", "node_modules", "bun", "bin", "bun.exe")]
      : []),
    ...(!windows ? ["/usr/local/bin/bun", "/opt/homebrew/bin/bun"] : []),
  ];
  return candidates.find(exists) || "bun";
}

module.exports = { findBun };
