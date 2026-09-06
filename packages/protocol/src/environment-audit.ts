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
}

export function assertEnvironmentAuditEvidenceV1(
  value: unknown,
): asserts value is EnvironmentAuditEvidenceV1 {
  const fail = () => {
    throw new Error("Invalid environment audit evidence");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join(",") !==
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
    !r.unmetCriteria.every(
      (s) => typeof s === "string" && s.trim() && s.length <= 1000,
    )
  )
    return fail();
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
