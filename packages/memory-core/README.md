# Paw Memory Core

`@paw/memory-core` is the runtime-independent part of Paw's evidence-first
long-term memory system. This directory is intentionally self-contained and
can become its own Git repository without copying Paw's agent runtime.

## What it does

```text
scoped query
  -> L0/L1 discovery
  -> typed evidence requirements
  -> immutable source lock
  -> optional source-local assistant-turn locator
  -> requirement-bound support selection
  -> optional read-only closure audit
  -> deterministic state reduction
  -> canonical evidence packet
```

- L0 dialogue/source spans are authoritative evidence.
- L1 memories are navigation hints and must hydrate back to L0 before use.
- The LLM can decompose a query and bind supplied evidence addresses, but it
  cannot change scope, invent evidence, write memory, or decide temporal order.
- An optional source-local locator can supplement a narrow assistant-recall
  lookup after source fusion. It returns exact L0 anchors plus bounded,
  addressable dialogue neighbors and can never widen the locked source set.
- Local hits still pass through the existing support selector. If localization
  or selection fails, the resolver discards them and preserves baseline output.
- The optional closure auditor is read-only. It may challenge closure but can no
  longer trigger retrieval or mutate the source set.
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
