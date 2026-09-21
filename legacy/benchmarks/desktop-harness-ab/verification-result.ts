/** Infrastructure failures are missing measurements, never functional zeroes. */
export function readVerification(result: {
  status: number | null;
  signal?: string | null;
  stdout: string | null;
  stderr: string | null;
  error?: unknown;
}) {
  try {
    if (result.status !== 0) throw new Error(`verifier exit ${result.status}`);
    const data = JSON.parse(result.stdout ?? "");
    if (
      !Number.isInteger(data.total) ||
      data.total <= 0 ||
      !Array.isArray(data.checks) ||
      data.checks.length !== data.total ||
      data.checks.some(
        (c: { pass?: unknown }) => typeof c.pass !== "boolean",
      ) ||
      data.passed !==
        data.checks.filter((c: { pass: boolean }) => c.pass).length
    )
      throw new Error("Incomplete or inconsistent verifier output");
    return { ...data, measured: true };
  } catch (error) {
    return {
      measured: false,
      passed: null,
      total: null,
      checks: [],
      error: String(result.error ?? error),
      status: result.status,
      signal: result.signal ?? null,
      stderr: (result.stderr ?? "").slice(0, 2000),
    };
  }
}
