import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildTestMapV1,
  extractPythonImports,
  findImpactedTests,
  renderImpactedTests,
} from "../src/loop-v2/test-map.js";

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-test-map-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

describe("code-test dependency map", () => {
  test("extractPythonImports parses from-import and plain-import", () => {
    const source = [
      "from django.utils import translation",
      "import sympy.sets",
      "import os, sys",
      "from . import sibling",
    ].join("\n");
    const imports = extractPythonImports(source);
    expect(imports).toContain("django.utils");
    expect(imports).toContain("sympy.sets");
    expect(imports).toContain("os");
    expect(imports).toContain("sys");
    expect(imports).toContain(".");
  });

  test("maps test files to source files via import analysis", () => {
    const root = makeWorkspace({
      "sklearn/base.py": "class BaseEstimator: pass\n",
      "sklearn/feature_selection/_base.py":
        "from sklearn.base import BaseEstimator\n",
      "tests/test_base.py":
        "from sklearn.base import BaseEstimator\n\ndef test_base():\n    assert BaseEstimator()\n",
      "tests/test_feature_select.py":
        "from sklearn.feature_selection._base import SelectorMixin\n\ndef test_select():\n    pass\n",
    });
    try {
      const map = buildTestMapV1(root);
      expect(map.entries.length).toBeGreaterThanOrEqual(2);
      const testBase = map.entries.find((e) =>
        e.testFile.includes("test_base.py"),
      );
      expect(testBase).toBeDefined();
      expect(testBase?.sourceFiles).toContain("sklearn/base.py");
      expect(testBase?.matchedBy).toContain("import");

      const testSelect = map.entries.find((e) =>
        e.testFile.includes("test_feature_select.py"),
      );
      expect(testSelect).toBeDefined();
      expect(testSelect?.sourceFiles).toContain(
        "sklearn/feature_selection/_base.py",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("findImpactedTests returns linked tests for changed source", () => {
    const root = makeWorkspace({
      "mypkg/core.py": "def compute(): return 42\n",
      "mypkg/helpers.py": "def assist(): pass\n",
      "tests/test_core.py":
        "from mypkg.core import compute\n\ndef test_compute():\n    assert compute() == 42\n",
      "tests/test_helpers.py":
        "from mypkg.helpers import assist\n\ndef test_assist():\n    assist()\n",
    });
    try {
      const map = buildTestMapV1(root);
      // 改 core.py → 应命中 test_core.py 而非 test_helpers.py
      const impacted = findImpactedTests(map, ["mypkg/core.py"]);
      expect(impacted.length).toBe(1);
      expect(impacted[0]?.testFile).toContain("test_core.py");

      // 改 helpers.py → 应命中 test_helpers.py
      const impactedHelpers = findImpactedTests(map, ["mypkg/helpers.py"]);
      expect(impactedHelpers.length).toBe(1);
      expect(impactedHelpers[0]?.testFile).toContain("test_helpers.py");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("renderImpactedTests produces factual summary", () => {
    const result = renderImpactedTests([
      {
        testFile: "tests/test_core.py",
        sourceFiles: ["mypkg/core.py"],
        testCommand: "python -m pytest tests/test_core.py -x -q",
        matchedBy: ["import"],
      },
    ]);
    expect(result).toContain("[ImpactedTests]");
    expect(result).toContain("1 test file");
    expect(result).toContain("tests/test_core.py");
  });

  test("empty workspace yields empty map", () => {
    const root = makeWorkspace({ "readme.txt": "not python\n" });
    try {
      const map = buildTestMapV1(root);
      expect(map.entries).toHaveLength(0);
      expect(renderImpactedTests([])).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
