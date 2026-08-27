import { createNGramMemoryEmbeddingServiceV1 } from "@paw/memory/longterm";

import type { ObservableMemoryEmbeddingServiceV1 } from "./openai-embedding.js";

export interface PartitionedHybridMemoryEmbeddingOptionsV1 {
  readonly dense: ObservableMemoryEmbeddingServiceV1;
  /** Number of meaningful leading dimensions returned by the padded dense adapter. */
  readonly denseSignalDimensions: number;
  readonly denseWeight?: number;
}

/**
 * Places dense and lexical vectors in disjoint coordinates. With normalized
 * components, cosine(output) = denseWeight*denseCos + lexicalWeight*lexicalCos.
 */
export function createPartitionedHybridMemoryEmbeddingServiceV1(
  input: PartitionedHybridMemoryEmbeddingOptionsV1,
): ObservableMemoryEmbeddingServiceV1 {
  const dimensions = input.dense.dimensions;
  const denseDimensions = input.denseSignalDimensions;
  const denseWeight = input.denseWeight ?? 0.25;
  if (
    !Number.isSafeInteger(denseDimensions) ||
    denseDimensions <= 0 ||
    denseDimensions >= dimensions
  ) {
    throw new Error("Hybrid dense signal dimensions are invalid");
  }
  if (!Number.isFinite(denseWeight) || denseWeight <= 0 || denseWeight >= 1) {
    throw new Error("Hybrid dense weight must be between zero and one");
  }
  const lexicalWeight = 1 - denseWeight;
  const lexicalDimensions = dimensions - denseDimensions;
  const lexical = createNGramMemoryEmbeddingServiceV1(lexicalDimensions);
  const model = `partitioned-ngram+dense:${input.dense.model}`;
  const version = `v1:dense=${denseWeight}:lexical=${lexicalWeight}:${input.dense.version}`;
  const service: ObservableMemoryEmbeddingServiceV1 = {
    dimensions,
    model,
    version,
    async embed(text: string): Promise<number[]> {
      const [rawDense, rawLexical] = await Promise.all([
        input.dense.embed(text),
        lexical.embed(text),
      ]);
      return combine(rawDense, rawLexical, denseDimensions, denseWeight);
    },
    async embedMany(
      texts: readonly string[],
    ): Promise<readonly (readonly number[])[]> {
      const [denseVectors, lexicalVectors] = await Promise.all([
        input.dense.embedMany(texts),
        Promise.all(texts.map((text) => lexical.embed(text))),
      ]);
      return Object.freeze(
        texts.map((_text, index) =>
          Object.freeze(
            combine(
              denseVectors[index]!,
              lexicalVectors[index]!,
              denseDimensions,
              denseWeight,
            ),
          ),
        ),
      );
    },
    snapshot: input.dense.snapshot.bind(input.dense),
    clear: input.dense.clear.bind(input.dense),
  };
  return Object.freeze(service);
}

function combine(
  rawDense: readonly number[],
  rawLexical: readonly number[],
  denseDimensions: number,
  denseWeight: number,
): number[] {
  const dense = normalized(rawDense.slice(0, denseDimensions));
  const lexicalVector = normalized(rawLexical);
  const denseScale = Math.sqrt(denseWeight);
  const lexicalScale = Math.sqrt(1 - denseWeight);
  return [
    ...dense.map((value) => value * denseScale),
    ...lexicalVector.map((value) => value * lexicalScale),
  ];
}

function normalized(vector: readonly number[]): number[] {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Hybrid embedding component is invalid");
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error("Hybrid embedding component has zero norm");
  }
  return vector.map((value) => value / norm);
}
