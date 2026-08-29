# Paw Memory Core

A runtime-independent, evidence-first long-term memory engine for AI agents.

Paw Memory treats retrieved summaries as navigation, not truth. Every answerable
memory must resolve back to immutable source evidence before it reaches a model.

## Why it is different

- **L0 is evidence.** Dialogue turns and source spans keep stable addresses,
  roles, order, timestamps, and hashes.
- **L1 is navigation.** Derived cards can find a source, but cannot become
  verified answer context until they hydrate back to L0.
- **Scope fails closed.** Planning, selection, and source-local lookup cannot
  widen the source set locked by deterministic retrieval.
- **LLMs have bounded jobs.** They may decompose a query or bind supplied
  evidence addresses. They cannot invent an address, change authority, write
  memory, or decide temporal order.
- **The core is portable.** Storage and model integrations are structural TypeScript
  ports with no Paw Runtime dependency.

## Read path

```text
scoped query
  -> L0/L1 discovery
  -> typed evidence requirements
  -> immutable source lock
  -> optional source-local lookup
  -> requirement-bound support selection
  -> deterministic state reduction
  -> canonical evidence packet
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module boundaries and trust rules.

## Quick start

```ts
import {
  createEvidenceIndex,
  createEvidenceResolver,
  createInMemoryStore,
} from "@paw/memory-core";

const store = createInMemoryStore({ scope });
const index = createEvidenceIndex({ profile, provider: store, archive: store });
const memory = createEvidenceResolver({ index });

const result = await memory.resolve(question, signal);
console.log(result.packetSources);
```

Run the complete zero-service example with:

```bash
bun run example
```

Production hosts replace the in-memory adapter with their own lexical/vector
provider and immutable evidence archive. Optional JSON planner and selector
ports are exposed as `createJsonQueryPlanner` and `createJsonSupportSelector`.

The historical versioned API remains available from
`@paw/memory-core/legacy`; the default entrypoint is intentionally small.

## Quality gates

```bash
bun install
bun run check
```

The package uses strict TypeScript, Biome, architecture dependency tests, and 86
unit tests. Benchmark methodology and claim limits are recorded in
[BENCHMARKS.md](./BENCHMARKS.md).

## Publication status

The code boundary is ready for an independent repository. The package remains
`private: true` until an explicit license and npm publication policy are chosen.
Source availability does not imply a license.
