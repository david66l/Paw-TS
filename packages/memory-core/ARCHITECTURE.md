# Architecture

## Trust model

Paw Memory separates discovery from evidence. L1 cards and search indexes may
propose a source, but only immutable L0 addresses can support an answer. A
selected address must belong to the locked source, match the requested role
boundary, and survive deterministic validation.

## Module map

```text
public-api.ts
  -> evidence-resolver.ts          orchestration
     -> evidence-resolution-pass.ts one bounded retrieval pass
     -> evidence-packet-builder.ts  canonical answer context
     -> evidence-authority.ts       role and source guards
     -> evidence-resolution-validation.ts fail-closed validation

query-plan-contracts.ts
  -> query-classifier.ts            deterministic intent and authority
  -> json-query-planner.ts          optional bounded LLM adapter

evidence-contracts.ts
  -> candidate-ranking.ts           deterministic L0/L1 fusion
  -> conversation-bundle.ts         role-preserving dialogue context
  -> evidence-notebook.ts           requirement coverage and state reduction
  -> evidence-text.ts               bounded excerpts and support scoring
```

`evidence-first.ts`, `evidence-query-planner.ts`, and
`evidence-resolver-helpers.ts` are compatibility barrels, not implementation
containers.

## LLM boundary

The deterministic classifier fixes answer shape, temporal mode, and role
constraint before an optional planner call. The planner can return at most four
search requirements and cannot select persistent IDs.

After retrieval, an optional selector can partition only supplied evidence
addresses into supporting, contradicting, or unknown sets. Its output is
revalidated against the locked sources and authority policy.

The optional closure auditor is read-only. It may report incomplete evidence,
but cannot trigger retrieval or mutate the source set.

## Failure behavior

Invalid model output, missing channels, address escape, role drift, stale
hydration, and source-local lookup failures degrade to partial or baseline
output. They never silently upgrade evidence to sufficient.

