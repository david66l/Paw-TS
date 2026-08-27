# Paw Memory Plugin

`@paw/memory-plugin` is the optional, evidence-first long-term-memory layer for
Paw Next. It is composed outside `@paw/runtime`: the runtime owns execution,
while this package owns memory scope, retrieval, evidence validation, temporal
projection, caching, and model-facing context.

The runtime-independent algorithm now lives in [`../memory-core`](../memory-core).
The plugin keeps Paw storage/composition adapters and compatibility exports;
the core directory is the source boundary intended for a separate repository.

See [OPEN_SOURCE_READINESS.md](./OPEN_SOURCE_READINESS.md) for the exact release
gate, completed safeguards, and remaining publication decisions.

## Core read path

```text
scoped query
  -> L0/L1 candidate discovery
  -> immutable source lock
  -> root or decomposed evidence requirements
  -> requirement-bound L0 support selection
  -> deterministic temporal reduction
  -> one canonical evidence packet
  -> product context / benchmark adapter
```

- **L0 is authoritative evidence.** Complete user/assistant dialogue is kept
  with role, source order, timestamps, hashes, and stable evidence addresses.
- **L1 is navigation.** Derived atoms can help find a source, but cannot be
  rendered or reported as verified L0. A selected L1 address must hydrate L0.
- **L2/L3 and graph projections are optional.** They improve navigation and
  explanation, but are not prerequisites for finding or answering from L0.
- **The runtime is not memory-aware.** Product composition installs this
  package through the existing context/input/tool plugin ports.

## LLM boundaries

The default product composition uses small, bounded model calls only where
semantic judgment is unavoidable:

1. Complex or explicit prior-assistant queries may be decomposed into at most
   four requirements. Simple queries may skip this decomposition call. The
   planner cannot select persistent IDs or answer.
2. A post-retrieval selector may bind only supplied L0 evidence addresses to
   those requirements. It cannot change scope, introduce an address, write a
   memory, or decide temporal winners.
3. State ordering, authority filtering, budgets, IDs, hashes, cache keys, and
   packet construction are deterministic code.

For multi-source lookups, the original question becomes an implicit root
requirement. A simple single-source lookup can skip the decomposition planner,
but the default product profile may still call the bounded support selector
unless code can issue a deterministic direct certificate.

## Evidence packet semantics

The shared resolver returns one packet used by both product and evaluation:

- `current`: controlling evidence for a latest-state answer;
- `ambiguous`: equal-position observations that code cannot safely resolve;
- `supporting`: evidence selected for a requirement;
- `candidate`: bounded high-ranking L0 retained for recall, but not counted as
  verified support;
- historical evidence refs remain in audit metadata and are not rendered as
  equal-rank current evidence.

`sufficient` means coverage closed over the bounded evidence actually retrieved;
it is not a proof that the store contains every relevant fact. It is allowed
only when every required item has selector-assessed support (or a deterministic
direct certificate), every evidence channel is healthy, and no contradiction
or unknown remains. Selector failure, missing L0, channel degradation, or
incomplete coverage degrades to `partial` or `missing`. The internal legacy
status name `verified` likewise means selector-assessed, not externally proven
truth.

## Scope and trust

- Every provider/archive/store is created with an exact tenant, user,
  workspace, and repository scope.
- The query and bounded planner search texts run only inside the frozen scope.
  Deterministic code fuses those results and then locks the final source set;
  the selector may bind only supplied addresses and cannot introduce a source,
  address, search, or scope of its own.
- Assistant output is context-only for user facts. It becomes directly
  readable only when the user explicitly asks to recall the assistant's prior
  words/actions, or adjacent user evidence confirms it.
- Logs contain versions, hashes, counts, timing, and cache settlements; they do
  not persist queries, answers, retrieved text, or credentials.

## Cache model

- Retrieval results are keyed by scope, query, provider/index identity, and
  revision plus a non-secret physical storage namespace. Two databases cannot
  share an entry merely because their logical revision counters match.
  Product-level settled query packets are not cached without a monotonic index
  revision; only concurrent identical calls are coalesced.
- Planner and selector responses use content-addressed local caches in the AMB
  harness. Provider prompt-cache tokens are logged separately from local hits.
- Stable L2/L3 navigation belongs in the stable prompt prefix; dynamic L0
  evidence belongs after that prefix so it does not invalidate KV cache.

## Verification

```powershell
bun run typecheck:memory-plugin
bun test packages/memory-plugin/test
bunx tsc --noEmit -p benchmarks/amb/tsconfig.json
bun test apps/cli/test/paw-next-composition-v2.test.ts
python -m unittest discover -s benchmarks/amb -p "test_*.py"
```

LongMemEval/AMB runs must use a content-free manifest, isolated answer/judge
cache for independent repeats, hash-only JSONL logs, and an exclusion manifest
for frozen holdouts. Development-set diagnostics and cache-reuse runs must not
be reported as public benchmark scores.

Before a release-gate run, generate the deterministic source bundle described
in `benchmarks/amb/LONGMEMEVAL_RELEASE_REPORT.md`. The blind plan must bind the
same source hash and serialize the project gate thresholds before either arm
is consumed.

Product composition imports `@paw/memory-plugin/evidence-first`, now a thin
alias of `@paw/memory-core`. The core's tested dependency closure contains no
Paw runtime package and excludes the legacy/shadow Aspect, Facet, and temporal
graph. The plugin root retains those exports for research and migration
compatibility.

## Known preview limits

- `latest` has an executable reducer and separates current text from historical
  audit refs. It is a local reduction over the retrieved set, not a proof that
  the globally newest fact was recalled. Requirement IDs are still coarse
  state keys, and product L0 timestamps currently reflect claim/write time when
  no explicit event time is available. Full `as_of`, `range`, and `history`
  contracts require explicit state keys and reference-time/boundary fields.
- The local benchmark dense index is a reproducible MiniLM helper, not a bundled
  production embedding service.
- The 120-query local paired blind gate passed at 79.2% versus a 66.7%
  baseline. See the benchmark release report for costs and the disclosed v5
  cache-binding protocol deviation. Independent custody and an independent
  judge are still required for a stronger public benchmark claim.
- Public release still requires an explicit repository license decision; a
  license must not be inferred from source availability.
