import { describe, expect, test } from "bun:test";

import {
  decomposeVerificationFailuresV2,
  isEnvironmentFailure,
  isOwnedFailure,
  renderVerificationFailureRecordsV2,
} from "../src/loop-v2/failure-records.js";

/** django-15098 真实形状：2 条真断言失败 + 1 条环境导入错误同屏。 */
const DJANGO_MIXED_OUTPUT = [
  "test_get_language_from_path_null (i18n.tests.MiscTests) ... ok",
  "----------------------------------------------------------------------",
  "ERROR: test_i18n_app_dirs (i18n.tests.WatchForTranslationChangesTests)",
  "Traceback (most recent call last):",
  '  File "/testbed/tests/runtests.py", line 471, in <module>',
  "    main()",
  '  File "/opt/miniconda3/envs/testbed/lib/python3.9/unittest/loader.py", line 436, in _find_test_path',
  "ModuleNotFoundError: No module named 'tests'",
  "",
  "======================================================================",
  "FAIL: test_get_language_from_path_real (i18n.tests.MiscTests)",
  "Traceback (most recent call last):",
  '  File "/testbed/tests/i18n/tests.py", line 118, in test_get_language_from_path_real',
  "    self.assertFalse(got)",
  "AssertionError: True is not false",
  "",
  "======================================================================",
  "FAIL: test_page_with_dash (i18n.tests.UnprefixedDefaultLanguageTests)",
  "Traceback (most recent call last):",
  '  File "/testbed/tests/i18n/tests.py", line 214, in test_page_with_dash',
  "    self.assertEqual(response.status_code, 200)",
  "AssertionError: 404 != 200",
  "",
  "----------------------------------------------------------------------",
  "Ran 214 tests in 30.612s",
  "",
  "FAILED (failures=2, errors=1)",
].join("\n");

const CHANGED = ["django/utils/translation/trans_real.py"];

describe("verification failure-record decomposition", () => {
  test("django signature: mixed output splits owned vs environment", () => {
    const records = decomposeVerificationFailuresV2({
      output: DJANGO_MIXED_OUTPUT,
      filesChanged: CHANGED,
    });
    expect(records).toHaveLength(3);
    const owned = records.filter(isOwnedFailure);
    const environment = records.filter(isEnvironmentFailure);
    expect(owned.map((r) => r.testId)).toContain(
      "test_get_language_from_path_real (i18n.tests.MiscTests)",
    );
    expect(owned.map((r) => r.testId)).toContain(
      "test_page_with_dash (i18n.tests.UnprefixedDefaultLanguageTests)",
    );
    expect(environment).toHaveLength(1);
    expect(environment[0]?.kind).toBe("import");
    expect(environment[0]?.errorLine).toContain("No module named 'tests'");
    // 环境记录的 traceback 不触及改动面（事实，不是名单）
    expect(environment[0]?.touchesChangeSurface).toBeFalse();
    // 渲染：事实陈述、分区呈现，无行为命令
    const rendered = renderVerificationFailureRecordsV2(records);
    expect(rendered).toContain("[VerificationFailureRecords]");
    expect(rendered).toContain("failures of the current change:");
    expect(rendered).toContain("environment failures");
    expect(rendered).toContain("does not overlap the change surface");
  });

  test("import error touching a changed file stays owned", () => {
    const output = [
      "ERROR: test_new_behavior (i18n.tests.MiscTests)",
      "Traceback (most recent call last):",
      '  File "django/utils/translation/trans_real.py", line 12, in <module>',
      "    from django.utils.translation import new_helper",
      "ModuleNotFoundError: No module named 'django.utils.translation.new_helper'",
    ].join("\n");
    const records = decomposeVerificationFailuresV2({
      output,
      filesChanged: CHANGED,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.touchesChangeSurface).toBeTrue();
    expect(isOwnedFailure(records[0]!)).toBeTrue();
  });

  test("pytest summary lines decompose with kind detection", () => {
    const output = [
      "FAILED tests/test_capture.py::test_fdcapture - AssertionError: assert False",
      "ERROR tests/test_x.py::test_y - ModuleNotFoundError: No module named 'conftest_helper'",
      "================== 1 failed, 1 error in 2.22s ==================",
    ].join("\n");
    const records = decomposeVerificationFailuresV2({
      output,
      filesChanged: [],
    });
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe("assertion");
    expect(records[1]?.kind).toBe("import");
  });

  test("clean output decomposes to zero records", () => {
    expect(
      decomposeVerificationFailuresV2({
        output: "214 passed in 30s",
        filesChanged: CHANGED,
      }),
    ).toHaveLength(0);
    expect(renderVerificationFailureRecordsV2([])).toBeUndefined();
  });
});
