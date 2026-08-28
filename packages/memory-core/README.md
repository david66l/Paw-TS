# Paw Memory Core

`@paw/memory-core` is the runtime-independent part of Paw's evidence-first
long-term memory system. This directory is intentionally self-contained and
can become its own Git repository without copying Paw's agent runtime.

## What it does

```text
scoped query
  -> L0/L1 discovery
  -> typed evidence requirements
  -> requirement-bound support selection
  -> independent closure audit
       -> at most one bounded repair search and full re-selection
  -> deterministic state reduction
  -> canonical evidence packet
```

- L0 dialogue/source spans are authoritative evidence.
- L1 memories are navigation hints and must hydrate back to L0 before use.
- The LLM can decompose a query and bind supplied evidence addresses, but it
  cannot change scope, invent evidence, write memory, or decide temporal order.
- A separate closure auditor checks the original query against the plan and
  selected L0 evidence. It may propose at most two search obligations for one
  repair pass; it cannot answer the query or insert evidence.
- A deterministic single-source certificate bypasses planner, selector, and
  auditor calls for clear direct lookups.
- Storage, model, and runtime integrations are structural ports.
- IDs, hashing, ranking, budgets, temporal reduction, and packet construction
  are deterministic code.

## Use

```ts
import {
  createMemoryEvidenceResolverV1,
  createProductMemoryEvidenceIndexV1,
} from "@paw/memory-core";
```

Implement `MemoryProductProviderV1`, `MemoryProductArchiveV1`, and optionally
`MemoryWriterModelV1`; no Paw runtime package is required.

For a zero-service demo, run `bun run example`. The bundled in-memory adapter
is deterministic and intended for examples/tests; production hosts can replace
it with their own lexical/vector index and immutable evidence archive.

## Verify

```bash
bun install
bun run check
```

## Publication status

The source boundary is ready for an independent repository. The package stays
`private: true` until the repository owner explicitly chooses a license and
reviews final package metadata. Do not infer a license from source access.
