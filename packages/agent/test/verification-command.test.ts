import { describe, expect, test } from "bun:test";

import {
  analyzeVerificationCommand,
  isVerificationCommand,
  verificationCommandFamily,
} from "../src/verification-command.js";

describe("verification command intent", () => {
  test("recognizes Python module tests through absolute cross-platform executables", () => {
    const commands = [
      '"C:\\Program Files\\Python310\\python.exe" -m pytest sympy/core/tests/test_kind.py -q',
      "C:\\Python311\\python.exe -m pytest tests\\test_value.py -q",
      "C:\\Users\\Rain\\AppData\\Local\\Programs\\Python\\Python310\\python.exe -m pytest sympy/core/tests/test_kind.py -q",
      "/opt/python/3.11/bin/python3.11 -m pytest tests/test_value.py -q",
      "py -3.10 -m pytest tests -q",
      "python -X dev -m pytest tests -q",
    ];

    for (const command of commands) {
      expect(isVerificationCommand(command)).toBe(true);
      expect(verificationCommandFamily(command)).toBe("pytest");
    }
  });

  test("rejects successful pytest modes which execute no assertions", () => {
    const diagnostics = [
      "pytest --version",
      "python -m pytest -V",
      "C:\\Users\\Rain\\AppData\\Local\\Programs\\Python\\Python310\\python.exe -m pytest --version",
      "python -m pytest --help",
      "python -m pytest -h",
      "pytest --collect-only tests",
      "pytest --co tests",
      "pytest --fixtures",
      "pytest --fixtures-per-test tests",
      "pytest --markers",
      "pytest --setup-only tests",
      "pytest --setup-plan tests",
      "python -V -m pytest tests",
    ];

    for (const command of diagnostics) {
      expect(analyzeVerificationCommand(command)).toBeUndefined();
    }
    expect(isVerificationCommand("pytest -v tests/test_value.py")).toBe(true);
  });

  test("preserves existing runner families through the shared analyzer", () => {
    expect(verificationCommandFamily("python -m unittest discover -v")).toBe(
      "unittest",
    );
    expect(
      verificationCommandFamily(
        "set PYTHONPATH=.&&python tests\\runtests.py queries.test_q.QCheckTests",
      ),
    ).toBe("python-runner");
    expect(verificationCommandFamily("python manage.py test app.tests")).toBe(
      "django",
    );
    expect(verificationCommandFamily("bun test packages/agent")).toBe(
      "javascript",
    );
    expect(verificationCommandFamily("node verify-test.js")).toBe("node");
    expect(verificationCommandFamily("go test ./...")).toBe("go");
    expect(verificationCommandFamily("cargo test --workspace")).toBe("cargo");
  });
});
