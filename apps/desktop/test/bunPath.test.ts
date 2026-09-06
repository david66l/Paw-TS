import { expect, test } from "bun:test";
import { createRequire } from "node:module";
const { findBun } = createRequire(import.meta.url)("../electron/bun-path.cjs");

test("Windows finds native npm Bun without trying to spawn the PowerShell shim", () => {
  const binary =
    "C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe";
  expect(
    findBun({
      platform: "win32",
      env: {
        USERPROFILE: "C:\\Users\\Test",
        APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
      },
      exists: (value: string) => value === binary,
    }),
  ).toBe(binary);
});

test("explicit Bun override, standalone installation and POSIX fallbacks retain precedence", () => {
  expect(
    findBun({
      env: { BUN_PATH: "custom-bun" },
      exists: (value: string) => value === "custom-bun",
    }),
  ).toBe("custom-bun");
  expect(
    findBun({
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\Test" },
      exists: () => true,
    }),
  ).toBe("C:\\Users\\Test\\.bun\\bin\\bun.exe");
  expect(
    findBun({
      platform: "darwin",
      env: {},
      exists: (value: string) => value === "/opt/homebrew/bin/bun",
    }),
  ).toBe("/opt/homebrew/bin/bun");
  expect(findBun({ platform: "win32", env: {}, exists: () => false })).toBe(
    "bun",
  );
});
