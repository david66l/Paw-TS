import { createHash } from "node:crypto";

import type { MemoryEmbeddingService } from "@paw/memory/longterm";

export type MemoryEmbeddingEventTypeV1 =
  | "hit"
  | "miss"
  | "retry"
  | "store"
  | "failed";

export interface MemoryEmbeddingEventV1 {
  readonly schemaVersion: "paw.memory-embedding-event.v1";
  readonly event: MemoryEmbeddingEventTypeV1;
  readonly model: string;
  readonly version: string;
  readonly textHash: string;
  readonly durationMs: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly reasonCode?: "transport" | "http_429" | "http_5xx";
}

export interface OpenAICompatibleMemoryEmbeddingOptionsV1 {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly version?: string;
  readonly dimensions?: number;
  readonly requestDimensions?: boolean;
  readonly timeoutMs?: number;
  readonly maxCacheEntries?: number;
  readonly maxBatchSize?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly fetch?: typeof fetch;
  readonly onEvent?: (event: MemoryEmbeddingEventV1) => void;
}

export interface ObservableMemoryEmbeddingServiceV1
  extends MemoryEmbeddingService {
  embedMany(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  snapshot(): Readonly<{
    hits: number;
    misses: number;
    stores: number;
    failures: number;
    entries: number;
    hitRate: number;
  }>;
  clear(): void;
}

const REQUIRED_VECTOR_DIMENSIONS = 1_536;

/** Caller-injected OpenAI-compatible dense embeddings; no credentials enter profiles. */
export function createOpenAICompatibleMemoryEmbeddingServiceV1(
  input: OpenAICompatibleMemoryEmbeddingOptionsV1,
): ObservableMemoryEmbeddingServiceV1 {
  const endpoint = embeddingEndpoint(input.baseUrl);
  const model = requiredIdentity(input.model, "model");
  const version = requiredIdentity(input.version ?? "1", "version");
  const dimensions = input.dimensions ?? REQUIRED_VECTOR_DIMENSIONS;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxEntries = input.maxCacheEntries ?? 2_048;
  const maxBatchSize = input.maxBatchSize ?? 64;
  const maxAttempts = input.maxAttempts ?? 3;
  const retryBaseDelayMs = input.retryBaseDelayMs ?? 200;
  if (dimensions !== REQUIRED_VECTOR_DIMENSIONS) {
    throw new Error(
      `Paw's current pgvector schema requires ${REQUIRED_VECTOR_DIMENSIONS}-dimension embeddings`,
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Memory embedding timeout must be positive");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("Memory embedding cache size must be positive");
  }
  if (
    !Number.isSafeInteger(maxBatchSize) ||
    maxBatchSize < 1 ||
    maxBatchSize > 64
  ) {
    throw new Error("Memory embedding batch size must be between 1 and 64");
  }
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5
  ) {
    throw new Error("Memory embedding max attempts must be between 1 and 5");
  }
  if (
    !Number.isSafeInteger(retryBaseDelayMs) ||
    retryBaseDelayMs < 0 ||
    retryBaseDelayMs > 5_000
  ) {
    throw new Error(
      "Memory embedding retry base delay must be between 0 and 5000ms",
    );
  }
  const request = input.fetch ?? globalThis.fetch;
  if (typeof request !== "function") {
    throw new Error("Memory embedding fetch implementation is unavailable");
  }
  const cache = new Map<string, readonly number[]>();
  const pending = new Map<string, Promise<readonly number[]>>();
  let hits = 0;
  let misses = 0;
  let stores = 0;
  let failures = 0;

  const service: ObservableMemoryEmbeddingServiceV1 = {
    dimensions,
    model,
    version,
    async embed(text: string): Promise<number[]> {
      const vectors = await service.embedMany([text]);
      return [...vectors[0]!];
    },
    async embedMany(
      texts: readonly string[],
    ): Promise<readonly (readonly number[])[]> {
      if (texts.length === 0) return Object.freeze([]);
      const items = texts.map((text) => {
        const normalized = text.trim();
        if (!normalized) throw new Error("Memory embedding text is empty");
        return {
          normalized,
          textHash: createHash("sha256").update(normalized).digest("hex"),
          startedAt: performance.now(),
        };
      });
      const missing = new Map<string, (typeof items)[number]>();
      const resolutions = new Map<string, Promise<readonly number[]>>();
      for (const item of items) {
        const cached = cache.get(item.textHash);
        if (cached) {
          cache.delete(item.textHash);
          cache.set(item.textHash, cached);
          hits += 1;
          emit(input, "hit", model, version, item.textHash, item.startedAt);
          resolutions.set(item.textHash, Promise.resolve(cached));
          continue;
        }
        const active = pending.get(item.textHash);
        if (active) {
          hits += 1;
          emit(input, "hit", model, version, item.textHash, item.startedAt);
          resolutions.set(item.textHash, active);
          continue;
        }
        if (missing.has(item.textHash)) {
          hits += 1;
          emit(input, "hit", model, version, item.textHash, item.startedAt);
          continue;
        }
        missing.set(item.textHash, item);
      }
      const newItems = [...missing.values()];
      for (let offset = 0; offset < newItems.length; offset += maxBatchSize) {
        const batch = newItems.slice(offset, offset + maxBatchSize);
        for (const item of batch) {
          misses += 1;
          emit(input, "miss", model, version, item.textHash, item.startedAt);
        }
        const operation = fetchEmbeddingsWithRetry({
          endpoint,
          apiKey: input.apiKey,
          model,
          dimensions,
          requestDimensions: input.requestDimensions === true,
          timeoutMs,
          texts: batch.map((item) => item.normalized),
          request,
          maxAttempts,
          retryBaseDelayMs,
          onRetry(attempt, reasonCode) {
            for (const item of batch) {
              emit(
                input,
                "retry",
                model,
                version,
                item.textHash,
                item.startedAt,
                {
                  attempt,
                  maxAttempts,
                  reasonCode,
                },
              );
            }
          },
        });
        const itemPromises = batch.map((_item, index) =>
          operation.then((vectors) => vectors[index]!),
        );
        for (const itemPromise of itemPromises) {
          // The batch operation is the authoritative failure path below. Attach
          // a rejection observer so per-item de-duplication promises cannot
          // become unhandled when the whole batch fails before resolution.
          void itemPromise.catch(() => undefined);
        }
        for (const [index, item] of batch.entries()) {
          const itemPromise = itemPromises[index]!;
          pending.set(item.textHash, itemPromise);
          resolutions.set(item.textHash, itemPromise);
        }
        try {
          const vectors = await operation;
          for (const [index, item] of batch.entries()) {
            const vector = vectors[index]!;
            cache.set(item.textHash, Object.freeze([...vector]));
            stores += 1;
            emit(input, "store", model, version, item.textHash, item.startedAt);
          }
          trimCache(cache, maxEntries);
        } catch (error) {
          for (const item of batch) {
            failures += 1;
            emit(
              input,
              "failed",
              model,
              version,
              item.textHash,
              item.startedAt,
            );
          }
          throw error;
        } finally {
          for (const item of batch) pending.delete(item.textHash);
        }
      }
      const result = await Promise.all(
        items.map(async (item) => {
          const resolution = resolutions.get(item.textHash);
          if (!resolution) {
            throw new Error("Memory embedding batch settlement missing");
          }
          return [...(await resolution)];
        }),
      );
      return Object.freeze(result.map((vector) => Object.freeze(vector)));
    },
    snapshot() {
      const attempts = hits + misses;
      return Object.freeze({
        hits,
        misses,
        stores,
        failures,
        entries: cache.size,
        hitRate: attempts === 0 ? 0 : hits / attempts,
      });
    },
    clear() {
      cache.clear();
      pending.clear();
      hits = 0;
      misses = 0;
      stores = 0;
      failures = 0;
    },
  };
  return Object.freeze(service);
}

type MemoryEmbeddingRetryReasonV1 = "transport" | "http_429" | "http_5xx";

class MemoryEmbeddingRequestError extends Error {
  readonly retryReason?: MemoryEmbeddingRetryReasonV1;

  constructor(
    message: string,
    options: {
      retryReason?: MemoryEmbeddingRetryReasonV1;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "MemoryEmbeddingRequestError";
    this.retryReason = options.retryReason;
  }
}

async function fetchEmbeddingsWithRetry(input: {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly dimensions: number;
  readonly requestDimensions: boolean;
  readonly timeoutMs: number;
  readonly texts: readonly string[];
  readonly request: typeof fetch;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly onRetry: (
    attempt: number,
    reasonCode: MemoryEmbeddingRetryReasonV1,
  ) => void;
}): Promise<readonly (readonly number[])[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      return await fetchEmbeddings(input);
    } catch (error) {
      lastError = error;
      const reasonCode =
        error instanceof MemoryEmbeddingRequestError
          ? error.retryReason
          : undefined;
      if (!reasonCode || attempt >= input.maxAttempts) throw error;
      input.onRetry(attempt + 1, reasonCode);
      const delayMs = input.retryBaseDelayMs * 2 ** (attempt - 1);
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function fetchEmbeddings(input: {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly dimensions: number;
  readonly requestDimensions: boolean;
  readonly timeoutMs: number;
  readonly texts: readonly string[];
  readonly request: typeof fetch;
}): Promise<readonly (readonly number[])[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let response: Response;
    try {
      response = await input.request(input.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.model,
          input: input.texts.length === 1 ? input.texts[0] : input.texts,
          ...(input.requestDimensions ? { dimensions: input.dimensions } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new MemoryEmbeddingRequestError(
        "Memory embedding request failed before receiving a response",
        { retryReason: "transport", cause: error },
      );
    }
    if (!response.ok) {
      throw new MemoryEmbeddingRequestError(
        `Memory embedding request failed with HTTP ${response.status}`,
        {
          retryReason:
            response.status === 429
              ? "http_429"
              : response.status >= 500
                ? "http_5xx"
                : undefined,
        },
      );
    }
    const payload = (await response.json()) as {
      data?: readonly { embedding?: unknown }[];
    };
    const vectors = payload.data?.map((item) => item.embedding);
    if (
      !vectors ||
      vectors.length !== input.texts.length ||
      vectors.some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.length !== input.dimensions ||
          vector.some(
            (value) => typeof value !== "number" || !Number.isFinite(value),
          ),
      )
    ) {
      throw new Error("Memory embedding response vector is invalid");
    }
    return Object.freeze(
      vectors.map((vector) => Object.freeze(vector as number[])),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function trimCache(
  cache: Map<string, readonly number[]>,
  maxEntries: number,
): void {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function embeddingEndpoint(value: string): string {
  const normalized = requiredIdentity(value, "baseUrl").replace(/\/+$/, "");
  return normalized.endsWith("/embeddings")
    ? normalized
    : `${normalized}/embeddings`;
}

function requiredIdentity(value: string, name: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 512 ||
    hasAsciiControlCharacter(normalized)
  ) {
    throw new Error(`Memory embedding ${name} is invalid`);
  }
  return normalized;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function emit(
  input: OpenAICompatibleMemoryEmbeddingOptionsV1,
  event: MemoryEmbeddingEventTypeV1,
  model: string,
  version: string,
  textHash: string,
  startedAt: number,
  details: Pick<
    MemoryEmbeddingEventV1,
    "attempt" | "maxAttempts" | "reasonCode"
  > = {},
): void {
  try {
    input.onEvent?.(
      Object.freeze({
        schemaVersion: "paw.memory-embedding-event.v1" as const,
        event,
        model,
        version,
        textHash,
        durationMs: Math.max(0, performance.now() - startedAt),
        ...details,
      }),
    );
  } catch {
    // Caller-owned telemetry never changes embedding semantics.
  }
}
