import { closeSql, getSql } from "../../packages/memory/src/db/connection.js";

const repositoryId = required("PAW_AMB_REBALANCE_REPOSITORY_ID");
if (!repositoryId.startsWith("amb-personamem-")) {
  throw new Error("Rebalancing is restricted to an AMB PersonaMem repository scope");
}
const model = required("PAW_AMB_REBALANCE_MODEL");
const sourceVersion = required("PAW_AMB_REBALANCE_SOURCE_VERSION");
const targetVersion = required("PAW_AMB_REBALANCE_TARGET_VERSION");
const denseDimensions = finiteInteger("PAW_AMB_REBALANCE_DENSE_DIMENSIONS", 384);
const sourceDenseWeight = finiteWeight("PAW_AMB_REBALANCE_SOURCE_DENSE_WEIGHT");
const targetDenseWeight = finiteWeight("PAW_AMB_REBALANCE_TARGET_DENSE_WEIGHT");
const sql = getSql();

try {
  const rows = await sql`
    SELECT e.memory_id, e.embedding
    FROM memory_embeddings e
    JOIN memory_items m ON m.id = e.memory_id
    WHERE m.scope->>'repositoryId' = ${repositoryId}
      AND e.embedding_model = ${model}
      AND e.embedding_version = ${sourceVersion}
    ORDER BY e.memory_id
  `;
  if (rows.length === 0) throw new Error("No source embeddings matched the AMB scope");
  const denseScale = Math.sqrt(targetDenseWeight / sourceDenseWeight);
  const lexicalScale = Math.sqrt(
    (1 - targetDenseWeight) / (1 - sourceDenseWeight),
  );
  await sql.begin(async (tx: any) => {
    for (const row of rows as unknown as Array<{
      memory_id: string;
      embedding: unknown;
    }>) {
      const source = parseVector(row.embedding);
      if (source.length !== 1_536 || denseDimensions >= source.length) {
        throw new Error("Source embedding dimensions are invalid");
      }
      const target = source.map((value, index) =>
        value * (index < denseDimensions ? denseScale : lexicalScale),
      );
      const formatted = `[${target.join(",")}]`;
      await tx`
        UPDATE memory_embeddings
        SET embedding = ${formatted}::vector,
            embedding_version = ${targetVersion},
            index_revision = index_revision + 1
        WHERE memory_id = ${row.memory_id}
          AND embedding_model = ${model}
          AND embedding_version = ${sourceVersion}
      `;
    }
  });
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: "paw.amb-embedding-rebalance.v1",
      repositoryId,
      model,
      sourceVersion,
      targetVersion,
      denseDimensions,
      sourceDenseWeight,
      targetDenseWeight,
      updated: rows.length,
    })}\n`,
  );
} finally {
  await closeSql();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function finiteInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value >= 1_536) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function finiteWeight(name: string): number {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be between zero and one`);
  }
  return value;
}

function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === "string") return JSON.parse(raw) as number[];
  throw new Error("Stored embedding is invalid");
}
