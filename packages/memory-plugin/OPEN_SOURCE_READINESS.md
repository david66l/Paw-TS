# Open-source readiness

## Ready

- Memory is installed by CLI composition through runtime context/input/tool
  ports; `@paw/runtime` has no dependency on `@paw/memory-plugin`.
- `packages/memory-core` is a self-contained package boundary with no `@paw/*`
  dependency. It includes structural storage/model ports, a deterministic
  in-memory reference adapter, its own README, TypeScript config, package
  metadata, and 56 standalone tests.
- Product composition keeps importing `@paw/memory-plugin/evidence-first`, a
  compatibility alias of the standalone core. Aspect, Facet, temporal graph,
  PostgreSQL, and Paw Runtime stay outside the core dependency closure.
- Tenant, user, workspace, repository, dossier, raw archive, provider, and
  physical storage-cache boundaries fail closed.
- L0 and L1 can degrade independently, while any degraded evidence channel
  prevents a `sufficient` packet.
- Semantic LLM caches are bound to a transitive workspace source-bundle hash;
  retrieval caches are bound to a non-secret physical storage namespace.
- Reusable L0 indexes are checked against every expected source/span ID and the
  exact active embedding model/version. Missing entries or vectors fail closed
  instead of silently falling back to lexical-only retrieval.
- Release protocol v4 preregisters context and memory-semantic call/token
  limits. Versioned cache envelopes preserve origin usage, so local response
  cache savings and provider KV-cache hits can be audited independently.
- A deterministic source ZIP, embedded file manifest, sealed per-query ledger,
  content-free public report, and paired exact comparator are available.
- The local persona-disjoint v5 gate scored 95/120 (79.2%) versus 80/120
  (66.7%), with 19 recoveries, 4 regressions, and exact McNemar `p=0.0025995`.
  Its disclosed cache-binding deviation and claim limits are documented in the
  benchmark release report.

## Required before publishing source

- Choose and add a repository license. Source availability alone grants no
  reuse rights.
- Decide whether the core is repository-source-only or an npm package. Its
  package surface and exports exist, but it remains `private: true`; npm
  publication still requires build output, provenance, and publish-policy
  review.
- Freeze the final package/source metadata, generate and archive the
  deterministic source bundle, and retain its public manifest with the release.
- Run the final targeted test matrix after the license/package decision.

## Required only for a stronger benchmark claim

- Run a source-bound clean semantic-cache confirmation after the final code
  freeze and pass the protocol-v4 cost gate. A rerun of v5 is a regression
  confirmation, not a new unseen holdout.
- Use an external CI/custodian for the blind split and one-shot arm state.
- Add an independent judge or submit through an official evaluation path.
- Implement first-class event-time/state-key contracts before claiming global
  temporal truth, `as_of`, `range`, or `history` support.

## Current verification commands

```powershell
bun run typecheck:memory-core
bun test packages/memory-core
bun run typecheck:memory-plugin
bun test packages/memory-plugin/test packages/memory/test/longterm-embedding-provider.test.ts
bunx tsc --noEmit -p benchmarks/amb/tsconfig.json
bun test benchmarks/amb
bun test --timeout 30000 apps/cli/test/paw-next-composition-v2.test.ts
benchmarks/amb/upstream/.venv/Scripts/python.exe -m unittest discover -s benchmarks/amb -p "test_*.py"
```

Repository-wide `typecheck` and `lint` currently have unrelated pre-existing
failures in `packages/harness`, `apps/cli/test/swe-watch.ts`, and other legacy
files. They are not memory-plugin release evidence and must not be silently
reported as passing. On Windows, the V3 collaboration cases in the product
composition test can exceed Bun's 5-second default while still completing
correctly, so the release command uses an explicit 30-second per-test timeout.
