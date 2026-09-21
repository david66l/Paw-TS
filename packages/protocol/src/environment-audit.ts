export interface VisualAuditCheckV1 {
  readonly screenshotHash: string;
  readonly requirementsHash: string;
  readonly reportHash: string;
  readonly verdict: "pass" | "fail" | "unknown";
  readonly summary: string;
  readonly checks: readonly {
    readonly criterion: string;
    readonly verdict: "pass" | "fail" | "unknown";
    readonly observation: string;
  }[];
}

export function assertVisualAuditCheckV1(value: unknown): asserts value is VisualAuditCheckV1 {
  const fail = () => {
    throw new Error("Invalid visual audit check");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (
    Object.keys(r).sort().join(",") !==
      "checks,reportHash,requirementsHash,screenshotHash,summary,verdict" ||
    ![r.screenshotHash, r.requirementsHash, r.reportHash].every(
      (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h),
    ) ||
    !["pass", "fail", "unknown"].includes(String(r.verdict)) ||
    !text(r.summary, 500) ||
    !Array.isArray(r.checks) ||
    r.checks.length < 1 ||
    r.checks.length > 8
  )
    return fail();
  const seen = new Set<string>();
  for (const check of r.checks) {
    if (
      !check ||
      Object.keys(check).sort().join(",") !== "criterion,observation,verdict" ||
      !text(check.criterion, 400) ||
      !text(check.observation, 600) ||
      seen.has(check.criterion) ||
      !["pass", "fail", "unknown"].includes(check.verdict) ||
      (r.verdict === "pass" && check.verdict !== "pass")
    )
      return fail();
    seen.add(check.criterion);
  }
}

export interface BrowserAuditCheckV1 {
  readonly visual?: VisualAuditCheckV1;
  readonly callId: string;
  readonly url: string;
  readonly scenarioHash: string;
  readonly observationHash: string;
  readonly assertions: number;
  readonly checkedAt: number;
}

export function assertBrowserAuditCheckV1(value: unknown): asserts value is BrowserAuditCheckV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid browser audit check");
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r)
      .filter((k) => k !== "visual")
      .sort()
      .join(",") !== "assertions,callId,checkedAt,observationHash,scenarioHash,url" ||
    typeof r.callId !== "string" ||
    !r.callId.trim() ||
    r.callId.length > 512 ||
    typeof r.url !== "string" ||
    r.url.length > 2048 ||
    !Number.isSafeInteger(r.assertions) ||
    Number(r.assertions) < 1 ||
    Number(r.assertions) > 12 ||
    !Number.isSafeInteger(r.checkedAt) ||
    Number(r.checkedAt) < 0 ||
    ![r.scenarioHash, r.observationHash].every(
      (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h),
    )
  )
    throw new Error("Invalid browser audit check");
  if (r.visual !== undefined) assertVisualAuditCheckV1(r.visual);
  const url = new URL(r.url);
  if (
    url.protocol !== "http:" ||
    !url.port ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid browser audit URL");
}

/** Environment evidence is produced by the host, never accepted from executor prose. */
export interface EnvironmentAuditEvidenceV1 {
  readonly policyVersion: "paw.environment-audit.v1";
  readonly candidateHash: string;
  readonly sourceRevision: string;
  readonly childSessionId: string;
  readonly childRunId: string;
  readonly integrity: "clean" | "suspect";
  readonly inspected: readonly {
    readonly path: string;
    readonly hash: string;
  }[];
  readonly unmetCriteria: readonly string[];
  readonly browserChecks?: readonly BrowserAuditCheckV1[];
}

export function assertEnvironmentAuditEvidenceV1(
  value: unknown,
): asserts value is EnvironmentAuditEvidenceV1 {
  const fail = () => {
    throw new Error("Invalid environment audit evidence");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r)
      .filter((k) => k !== "browserChecks")
      .sort()
      .join(",") !==
      "candidateHash,childRunId,childSessionId,inspected,integrity,policyVersion,sourceRevision,unmetCriteria" ||
    r.policyVersion !== "paw.environment-audit.v1" ||
    typeof r.sourceRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.sourceRevision) ||
    typeof r.candidateHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.candidateHash) ||
    typeof r.childRunId !== "string" ||
    !/^child-run-[a-f0-9]{32}$/.test(r.childRunId) ||
    typeof r.childSessionId !== "string" ||
    !/^child-session-[a-f0-9]{32}$/.test(r.childSessionId) ||
    !["clean", "suspect"].includes(String(r.integrity)) ||
    !Array.isArray(r.inspected) ||
    r.inspected.length > 64 ||
    !Array.isArray(r.unmetCriteria) ||
    r.unmetCriteria.length > 32 ||
    !r.unmetCriteria.every((s) => typeof s === "string" && s.trim() && s.length <= 1000)
  )
    return fail();
  if (r.browserChecks !== undefined) {
    if (!Array.isArray(r.browserChecks) || r.browserChecks.length > 12) return fail();
    const calls = new Set<string>();
    for (const check of r.browserChecks) {
      assertBrowserAuditCheckV1(check);
      if (calls.has(check.callId)) return fail();
      calls.add(check.callId);
    }
  }
  const paths = new Set<string>();
  for (const item of r.inspected) {
    if (
      !item ||
      Object.keys(item).sort().join(",") !== "hash,path" ||
      typeof item.path !== "string" ||
      !item.path.trim() ||
      item.path.length > 1000 ||
      paths.has(item.path) ||
      typeof item.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.hash)
    )
      return fail();
    paths.add(item.path);
  }
}
