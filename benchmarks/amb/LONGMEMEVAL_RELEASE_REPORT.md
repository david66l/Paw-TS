# Paw Evidence-First Memory: LongMemEval Release Report

Status: **project release gate passed; not an official AMB leaderboard result**.

This report records the first 120-query, persona-disjoint, paired local blind
evaluation of Paw's evidence-first memory plugin. It is intentionally narrower
than a public leaderboard claim: selection and one-shot arm custody were local,
and DeepSeek Flash served as both answer model and judge because no Gemini key
was available.

## Result

Both arms used the same 120 queries, 120 distinct users, 5,711 pre-query
history documents, local dense index, DeepSeek configuration, answer prompt,
judge, and `k=8`. The only intended arm difference was evidence-first query
expansion and closure in the treatment.

| Metric | Baseline | Evidence-first | Delta |
| --- | ---: | ---: | ---: |
| Answer accuracy | 80/120 (66.7%) | 95/120 (79.2%) | +12.5 pp |
| Gold-source hit rate | 90.7% | 94.9% | +4.2 pp |
| Macro gold-source recall | 85.5% | 89.7% | +4.3 pp |
| Mean reciprocal rank | 85.1% | 88.1% | +3.0 pp |
| Evidence-closure rate | 0.0% | 52.5% | +52.5 pp |
| Accuracy when treatment closed evidence | n/a | 88.9% | n/a |
| Average retrieval time | 139.9 ms | 1,254.0 ms | +1,114.2 ms |
| Average rendered context | 1,009 tokens | 1,343 tokens | +33.1% |

| Question type | Baseline | Evidence-first | Delta |
| --- | ---: | ---: | ---: |
| Single-session user | 90.5% | 100.0% | +9.5 pp |
| Single-session assistant | 76.2% | 76.2% | 0.0 pp |
| Multi-session | 28.6% | 61.9% | +33.3 pp |
| Temporal reasoning | 71.4% | 76.2% | +4.8 pp |
| Knowledge update | 81.0% | 95.2% | +14.3 pp |
| Single-session preference | 46.7% | 60.0% | +13.3 pp |

The paired contingency was 76 both-correct, 21 both-wrong, 19 baseline-wrong /
treatment-correct, and 4 baseline-correct / treatment-wrong. The exact
two-sided McNemar p-value is `0.0025995`; observed error count fell by 37.5%.
This passes the project's gate of treatment accuracy at least 75%, every
category at least 60%, paired gain at least 7.5 points, and no retrieval hit or
recall degradation greater than two points. Those thresholds were used in the
working plan but were not serialized into the v5 blind artifact, so the v5
files cannot cryptographically prove preregistration. Runner protocol v3 now
binds them into future plans. They are Paw criteria, not official AMB
thresholds.

## Observed treatment cost

This run had a mixed warm-cache profile and must not be presented as a cold
cost comparison:

- memory semantic calls: 112 remote, 52 local response-cache hits, 304,991
  provider-reported prompt-plus-completion tokens;
- answer calls: 87 remote, 33 local response-cache hits, 258,072 reported tokens;
- judge calls: 68 remote, 52 local response-cache hits, 42,705 reported tokens;
- combined: 267 remote calls, 137 local hits, and 605,768 reported tokens.

The baseline answer and judge calls were all served from the local deterministic
response cache left by an earlier arm whose scores were never inspected.
Therefore accuracy is paired and reproducible, but the observed baseline and
treatment API spend is not a fair cold-cache cost A/B. Provider KV-cache tokens
and local response-cache hits are separate counters.

Runner protocol v4 closes this accounting gap for future release runs. Local
answer/judge and memory-semantic cache entries now retain the origin request's
usage in a versioned envelope, while reports keep actual remote usage, locally
avoided origin usage, and provider KV-cache tokens separate. The preregistered
project gate now also requires complete cost evidence, no more than 50% context
growth over baseline, at most 2 memory-semantic calls per treatment query, and
at most 4,000 memory-semantic workload tokens per treatment query. These are
project engineering limits, not official AMB thresholds. The frozen v5 result
predates this envelope and therefore remains accuracy evidence, not a complete
cold-cost gate result.

## Blind protocol and disclosed deviation

The public plan was created before either v5 score was read. It selected one
query per persona with global bipartite matching, excluded the 30-query
development set and 48-query frozen holdout, committed the secret seed, bound
the dataset and source artifact hashes, and allowed each arm to be consumed
once. Public reports contain aggregate metrics only; HMAC identities and
per-query rows remain sealed.

The v5 manifest overstates one cache property. It says the LLM cache policy was
bound to the complete source artifact, while memory planner/selector entries
were actually keyed by prompt, model, endpoint, and generation configuration.
Cached completions were still parsed and validated under the frozen code, and
the only post-v4 pre-v5 core fix was a downstream minimum excerpt-budget guard.
No v4 score or per-query v5 row was inspected before both v5 arms completed.
The selection and paired accuracy remain useful evidence, but v5 must be
labelled **local one-shot blind with a disclosed cache-binding deviation**, not
a perfectly conforming independent blind trial.

Runner v8 corrects this for future runs: semantic cache keys now include a
transitive workspace source-bundle SHA-256. The bundle covers every Paw package
source tree, CLI composition, AMB TypeScript/Python adapter, pinned upstream
Python sources, package manifests, and dependency locks. The experiment
protocol records the hash and regression tests require representative
transitive dependencies. Any covered source change therefore uses a new
semantic-cache namespace.

Post-v5 hardening also adds physical storage namespaces to retrieval-cache
keys, fail-closed scope checks for dossier and raw-archive injection, and
independent L0/L1 degradation. Reusable L0 indexes now validate the complete
expected ID set and exact embedding model/version before skipping ingestion;
an incomplete dense index fails closed instead of silently using lexical-only
retrieval. These changes have unit, type, lint, database, and product
composition coverage, but the 79.2% number remains the frozen v5 result; it
must not be relabelled as a score produced by the later hardened source bundle.

## Artifact identity

The generated run directory is gitignored. Retain these hashes with archived
artifacts:

| Artifact | SHA-256 |
| --- | --- |
| Public plan | `8a7ff7851a25d792729e17e428148f6eb92f0121aee0a973763ed16e224da2b0` |
| Public baseline | `fd87a95bf9bd622ca0e7da48ac2a0bc723d57493a5b1e78464747ef0e04cc3f3` |
| Public treatment | `9612c9189e54c0af48a75c65c5ea47bb0d9dbf9467afc7d4b30cdf8e1bb3dd7a` |
| Public paired comparison | `49b341d3e0cb03967ace5fec7eef3a58d53603e38af35ce181337b999bec7248` |
| Frozen v5 source artifact | `45e783e4c16b641cbb992befa9319ac00f401ee757531b4a86deb759000b8505` |
| LongMemEval dataset artifact | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |

The content-free paired report can be regenerated from archived public and
sealed ledgers:

```powershell
python benchmarks/amb/compare_paw_longmemeval_blind.py `
  --baseline-public <baseline-public.json> `
  --baseline-sealed <baseline-sealed.json> `
  --treatment-public <treatment-public.json> `
  --treatment-sealed <treatment-sealed.json> `
  --output <paired-comparison.json>
```

For future runs, archive the exact source bundle before executing either arm:

```powershell
python benchmarks/amb/archive_paw_longmemeval_source.py `
  --output <source-bundle.zip> `
  --manifest-output <source-bundle-manifest.json>
```

The ZIP has deterministic timestamps, ordering, permissions, compression, and
an embedded per-file SHA-256 manifest. Rebuilding from unchanged source must
produce the same bundle hash.

## Remaining claim limits

- Local fixed-ledger custody is tamper-evident after creation but not an
  independent external custodian or CI-held blind split.
- LongMemEval gold document IDs cover histories, not exact support turns;
  source recall is useful attribution, not perfect evidence recall.
- The run evaluates a static initial evidence packet. It does not evaluate
  product-level progressive memory tool recovery.
- `eventKey` coverage was zero, so event identity used episode fallback rather
  than cross-session semantic event deduplication.
- Same-model judging can introduce correlated model bias. A future public claim
  should add an independent judge or official submission path.
- The repository still requires an explicit license choice before publication.
