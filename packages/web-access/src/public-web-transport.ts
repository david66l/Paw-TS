import { lookup as dnsLookup } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import net from "node:net";

import {
  DEFAULT_WEB_ACCESS_POLICY_V1,
  type WebAccessPolicyV1,
  freezeWebAccessPolicyV1,
} from "./policy.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
] as const;
const USER_AGENT = "Mozilla/5.0 (compatible; Paw-WebAccess/1.0)";

export interface PublicWebAddressV1 {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PublicWebHopRequestV1 {
  readonly url: URL;
  readonly address: PublicWebAddressV1;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly userAgent: string;
}

export interface PublicWebHopResponseV1 {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
}

export interface PublicWebTransportResultV1 extends PublicWebHopResponseV1 {
  readonly finalUrl: string;
  readonly redirectCount: number;
}

export interface PublicWebTransportV1 {
  getText(
    url: string,
    signal?: AbortSignal,
  ): Promise<PublicWebTransportResultV1>;
}

export interface PublicWebTransportDependenciesV1 {
  readonly resolveAddresses?: (
    hostname: string,
    signal?: AbortSignal,
  ) => Promise<readonly PublicWebAddressV1[]>;
  readonly requestHop?: (
    input: PublicWebHopRequestV1,
    signal?: AbortSignal,
  ) => Promise<PublicWebHopResponseV1>;
}

export interface CreatePublicWebTransportOptionsV1 {
  readonly policy?: WebAccessPolicyV1;
  /** @internal Deterministic test seam; production uses pinned Node HTTP. */
  readonly dependencies?: PublicWebTransportDependenciesV1;
}

/**
 * Public-internet-only text transport. DNS is checked and the selected public
 * address is pinned into the socket lookup for every redirect hop.
 */
export function createPublicWebTransportV1(
  options: CreatePublicWebTransportOptionsV1 = {},
): PublicWebTransportV1 {
  const policy = freezeWebAccessPolicyV1(
    options.policy ?? DEFAULT_WEB_ACCESS_POLICY_V1,
  );
  const resolveAddresses =
    options.dependencies?.resolveAddresses ?? resolvePublicAddressesV1;
  const requestHop = options.dependencies?.requestHop ?? requestPinnedHop;
  const transport: PublicWebTransportV1 = {
    async getText(input, signal) {
      let current = parsePublicWebUrlV1(input);
      const seen = new Set<string>();
      for (let redirectCount = 0; ; redirectCount += 1) {
        throwIfAborted(signal);
        const canonicalUrl = current.toString();
        if (seen.has(canonicalUrl)) {
          throw new Error("Web request redirect loop detected");
        }
        seen.add(canonicalUrl);
        const addresses = await resolveAddresses(
          normalizedHostname(current),
          signal,
        );
        throwIfAborted(signal);
        if (addresses.length === 0) {
          throw new Error("Web host resolved to no address");
        }
        for (const address of addresses) {
          if (!isPublicInternetAddressV1(address.address)) {
            throw new Error("Web host resolved to a non-public address");
          }
          if (net.isIP(address.address) !== address.family) {
            throw new Error("Web DNS result has an invalid address family");
          }
        }
        const selected =
          addresses.find((address) => address.family === 4) ?? addresses[0];
        if (!selected) throw new Error("Web host resolved to no address");
        const response = await requestHop(
          {
            url: current,
            address: selected,
            timeoutMs: policy.requestTimeoutMs,
            maxResponseBytes: policy.maxResponseBytes,
            userAgent: USER_AGENT,
          },
          signal,
        );
        throwIfAborted(signal);
        const location = response.headers.location;
        if (!REDIRECT_STATUSES.has(response.status) || !location) {
          return Object.freeze({
            ...response,
            finalUrl: current.toString(),
            redirectCount,
          });
        }
        if (redirectCount >= policy.maxRedirects) {
          throw new Error("Web request redirect limit exceeded");
        }
        const next = parsePublicWebUrlV1(new URL(location, current).toString());
        if (current.protocol === "https:" && next.protocol !== "https:") {
          throw new Error("Web request refused an HTTPS downgrade redirect");
        }
        current = next;
      }
    },
  };
  return Object.freeze(transport);
}

/** Strict syntax gate shared by plugins and the transport. */
export function parsePublicWebUrlV1(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Web URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Web URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Web URL credentials are not allowed");
  }
  if (url.port) {
    throw new Error("Web URL must use the protocol default port");
  }
  const hostname = normalizedHostname(url);
  if (!hostname || hostname.length > 253) {
    throw new Error("Web URL hostname is invalid");
  }
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  ) {
    throw new Error("Web URL hostname is not public");
  }
  const ipFamily = net.isIP(hostname);
  if (ipFamily !== 0) {
    if (!isPublicInternetAddressV1(hostname)) {
      throw new Error("Web URL address is not public");
    }
  } else if (!hostname.includes(".")) {
    throw new Error("Web URL hostname must be a public DNS name");
  }
  url.hash = "";
  return url;
}

/** True only for globally routable IPv4 or IPv6 unicast addresses. */
export function isPublicInternetAddressV1(input: string): boolean {
  const family = net.isIP(input);
  if (family === 4) return isPublicIpv4(input);
  if (family === 6) return isPublicIpv6(input);
  return false;
}

/** @internal Exported for runtime compatibility tests. */
export async function resolvePublicAddressesV1(
  hostname: string,
  signal?: AbortSignal,
): Promise<readonly PublicWebAddressV1[]> {
  throwIfAborted(signal);
  const family = net.isIP(hostname);
  if (family === 4 || family === 6) {
    return Object.freeze([
      Object.freeze({ address: hostname, family: family as 4 | 6 }),
    ]);
  }
  const answers = await new Promise<readonly PublicWebAddressV1[]>(
    (resolve, reject) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (error, results) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(results as readonly PublicWebAddressV1[]);
      });
    },
  );
  throwIfAborted(signal);
  return Object.freeze(
    answers.map((answer) =>
      Object.freeze({
        address: answer.address,
        family: answer.family as 4 | 6,
      }),
    ),
  );
}

function requestPinnedHop(
  input: PublicWebHopRequestV1,
  signal?: AbortSignal,
): Promise<PublicWebHopResponseV1> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      outcome:
        | { readonly ok: true; readonly value: PublicWebHopResponseV1 }
        | { readonly ok: false; readonly error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (outcome.ok) resolve(Object.freeze(outcome.value));
      else reject(outcome.error);
    };
    const onAbort = (): void => {
      request.destroy(abortError(signal));
      finish({ ok: false, error: abortError(signal) });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const lookup = createPinnedLookupV1(input.address);
    const client = input.url.protocol === "https:" ? https : http;
    const request = client.request(
      {
        protocol: input.url.protocol,
        hostname: normalizedHostname(input.url),
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        lookup,
        ...(input.url.protocol === "https:"
          ? { servername: normalizedHostname(input.url) }
          : {}),
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "identity",
          "User-Agent": input.userAgent,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let truncated = false;
        const complete = (): void => {
          finish({
            ok: true,
            value: {
              status: response.statusCode ?? 0,
              headers: normalizeHeaders(response.headers),
              body: Buffer.concat(chunks).toString("utf8"),
              truncated,
            },
          });
        };
        response.on("data", (raw: Buffer | string) => {
          if (settled) return;
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          const remaining = input.maxResponseBytes - totalBytes;
          if (chunk.length <= remaining) {
            chunks.push(chunk);
            totalBytes += chunk.length;
            return;
          }
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          totalBytes = input.maxResponseBytes;
          truncated = true;
          complete();
          response.destroy();
        });
        response.once("end", complete);
        response.once("error", (error) => {
          if (!settled) finish({ ok: false, error });
        });
      },
    );
    request.once("error", (error) => {
      if (!settled) finish({ ok: false, error });
    });
    request.setTimeout(input.timeoutMs, () => {
      const error = new Error("Web request timed out");
      request.destroy(error);
      finish({ ok: false, error });
    });
    request.end();
  });
}

/** @internal Supports both Node's single-address and Bun's all-address lookup. */
export function createPinnedLookupV1(
  address: PublicWebAddressV1,
): http.RequestOptions["lookup"] {
  return ((...args: unknown[]) => {
    const callback = args.at(-1) as (...callbackArgs: unknown[]) => void;
    const options =
      args.length >= 3 ? (args[1] as { all?: boolean }) : undefined;
    if (options?.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  }) as http.RequestOptions["lookup"];
}

function normalizeHeaders(
  headers: http.IncomingHttpHeaders,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : String(value);
  }
  return Object.freeze(normalized);
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicIpv4(input: string): boolean {
  const bytes = input.split(".").map(Number);
  if (
    bytes.length !== 4 ||
    bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(input: string): boolean {
  const bytes = parseIpv6(input);
  if (!bytes) return false;
  // Only global unicast 2000::/3 is eligible.
  if (((bytes[0] as number) & 0xe0) !== 0x20) return false;
  // Documentation 2001:db8::/32 and benchmarking 2001:2::/48.
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return false;
  }
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x02 &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x00
  ) {
    return false;
  }
  return true;
}

function parseIpv6(input: string): readonly number[] | undefined {
  if (input.includes("%") || input.split("::").length > 2) return undefined;
  let candidate = input.toLowerCase();
  const ipv4Tail = candidate.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const bytes = ipv4Tail.split(".").map(Number);
    if (
      bytes.length !== 4 ||
      bytes.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 255,
      )
    ) {
      return undefined;
    }
    const high = (((bytes[0] as number) << 8) | (bytes[1] as number)).toString(
      16,
    );
    const low = (((bytes[2] as number) << 8) | (bytes[3] as number)).toString(
      16,
    );
    candidate = `${candidate.slice(0, -ipv4Tail.length)}${high}:${low}`;
  }
  const compressed = candidate.includes("::");
  const [leftRaw = "", rightRaw = ""] = candidate.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
    (!compressed && left.length !== 8) ||
    (compressed && left.length + right.length >= 8)
  ) {
    return undefined;
  }
  const groups = compressed
    ? [
        ...left,
        ...Array<string>(8 - left.length - right.length).fill("0"),
        ...right,
      ]
    : left;
  if (groups.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Web request aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
