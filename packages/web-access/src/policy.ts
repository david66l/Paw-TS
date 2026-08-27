export interface WebAccessPolicyV1 {
  readonly defaultFetchChars: number;
  readonly maxFetchChars: number;
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs: number;
  readonly maxRedirects: number;
  readonly maxSearchResults: number;
  readonly maxQueryChars: number;
}

export const DEFAULT_WEB_ACCESS_POLICY_V1: WebAccessPolicyV1 = Object.freeze({
  defaultFetchChars: 50_000,
  maxFetchChars: 100_000,
  maxResponseBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  maxRedirects: 5,
  maxSearchResults: 10,
  maxQueryChars: 500,
});

export function freezeWebAccessPolicyV1(
  input: WebAccessPolicyV1,
): WebAccessPolicyV1 {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !==
      "defaultFetchChars\0maxFetchChars\0maxQueryChars\0maxRedirects\0maxResponseBytes\0maxSearchResults\0requestTimeoutMs"
  ) {
    throw new Error("Web access policy is invalid");
  }
  for (const value of Object.values(input)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Web access policy is invalid");
    }
  }
  if (
    input.defaultFetchChars > input.maxFetchChars ||
    input.maxFetchChars > 1_000_000 ||
    input.maxResponseBytes > 32 * 1024 * 1024 ||
    input.requestTimeoutMs > 120_000 ||
    input.maxRedirects > 10 ||
    input.maxSearchResults > 25 ||
    input.maxQueryChars > 2_000
  ) {
    throw new Error("Web access policy is invalid");
  }
  return Object.freeze({ ...input });
}

export function webAccessPolicyIdentityV1(policy: WebAccessPolicyV1): string {
  return [
    "paw.web-access.v1:bing-html-v1",
    `d${policy.defaultFetchChars}`,
    `c${policy.maxFetchChars}`,
    `b${policy.maxResponseBytes}`,
    `t${policy.requestTimeoutMs}`,
    `r${policy.maxRedirects}`,
    `s${policy.maxSearchResults}`,
    `q${policy.maxQueryChars}`,
  ].join(":");
}
