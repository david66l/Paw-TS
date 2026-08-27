export interface AmbEmbeddingStreamReportV1 {
  readonly batchCount: number;
  readonly itemCount: number;
}

/** Groups ordered work so the whole next wave remains inside the bounded LRU. */
export function planAmbEmbeddingWavesV1<T>(input: Readonly<{
  items: readonly T[];
  weight: (item: T) => number;
  maxWeight: number;
  maxItems: number;
}>): readonly (readonly T[])[] {
  if (
    !Number.isSafeInteger(input.maxWeight) ||
    input.maxWeight < 1 ||
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1
  ) {
    throw new Error("AMB embedding wave bounds are invalid");
  }
  const waves: T[][] = [];
  let wave: T[] = [];
  let waveWeight = 0;
  for (const item of input.items) {
    const weight = input.weight(item);
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new Error("AMB embedding wave item weight is invalid");
    }
    if (
      wave.length > 0 &&
      (wave.length >= input.maxItems || waveWeight + weight > input.maxWeight)
    ) {
      waves.push(wave);
      wave = [];
      waveWeight = 0;
    }
    wave.push(item);
    waveWeight += weight;
    if (weight > input.maxWeight || wave.length >= input.maxItems) {
      waves.push(wave);
      wave = [];
      waveWeight = 0;
    }
  }
  if (wave.length > 0) waves.push(wave);
  return Object.freeze(waves.map((items) => Object.freeze(items)));
}

/**
 * Bounded streaming aperture for large derived-index builds.
 *
 * The embedding client already supports ordered batches, but a corpus-wide
 * prewarm cannot fit in its bounded LRU cache.  This helper keeps only one
 * batch resident: prewarm the batch, persist it, then advance.  The caller is
 * responsible for making persistBatch idempotent and key-ordered.
 */
export async function streamAmbEmbeddingBatchesV1<T>(input: Readonly<{
  items: readonly T[];
  batchSize: number;
  text: (item: T) => string;
  prewarm: (texts: readonly string[]) => Promise<unknown>;
  persistBatch: (items: readonly T[]) => Promise<void>;
}>): Promise<AmbEmbeddingStreamReportV1> {
  if (
    !Number.isSafeInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > 64
  ) {
    throw new Error("AMB embedding stream batch size must be between 1 and 64");
  }
  let batchCount = 0;
  let itemCount = 0;
  for (let offset = 0; offset < input.items.length; offset += input.batchSize) {
    const batch = input.items.slice(offset, offset + input.batchSize);
    const texts = batch.map((item) => {
      const text = input.text(item).trim();
      if (!text) throw new Error("AMB embedding stream text is empty");
      return text;
    });
    await input.prewarm(texts);
    await input.persistBatch(batch);
    batchCount += 1;
    itemCount += batch.length;
  }
  return Object.freeze({ batchCount, itemCount });
}
