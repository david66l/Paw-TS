import { expect, test } from "bun:test";
import { readVerification } from "./verification-result.js";

test("a real failed functional check remains a measured zero", () => {
  expect(
    readVerification({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        passed: 0,
        total: 1,
        checks: [{ pass: false }],
      }),
    }),
  ).toMatchObject({ measured: true, passed: 0, total: 1 });
});

test("empty output, timeouts and incomplete results are unmeasured", () => {
  for (const result of [
    { status: 0, stdout: "", stderr: "" },
    { status: null, stdout: "", stderr: "", error: new Error("ETIMEDOUT") },
    { status: 0, stdout: '{"passed":15,"total":15,"checks":[]}', stderr: "" },
    {
      status: 0,
      stdout: '{"passed":1,"total":1,"checks":[{"pass":false}]}',
      stderr: "",
    },
  ])
    expect(readVerification(result)).toMatchObject({
      measured: false,
      passed: null,
      total: null,
    });
});
