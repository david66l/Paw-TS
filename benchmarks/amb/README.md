# Paw on Agent Memory Benchmark (AMB)

The current evidence-first LongMemEval release-gate result and its limitations
are recorded in [LONGMEMEVAL_RELEASE_REPORT.md](./LONGMEMEVAL_RELEASE_REPORT.md).
The retained local paired blind run scored 95/120 (79.2%) versus 80/120 (66.7%)
for the bounded baseline, with an exact paired p-value of 0.0026. It is a
project-local release gate, not an official AMB leaderboard submission.

For an official-split-scale local run, use `--full-split`. The runner fails
closed unless the pinned LongMemEval-S artifact exposes exactly 500 unique
queries and 500 isolated users. Full-split mode cannot be combined with prior
holdout exclusions; it is a public full-suite regression, not a new unseen
holdout.

This adapter runs Paw M1 retrieval against Vectorize's public Agent Memory
Benchmark without modifying Paw's runtime or the upstream benchmark package.

## Pin and layout

- Upstream: `vectorize-io/agent-memory-benchmark`
- Commit: see `UPSTREAM_COMMIT`
- `upstream/` is downloaded/cloned locally and gitignored.
- Paw's provider, JSONL bridge, smoke, and runner wrapper are tracked here.
- Generated results live under `benchmarks/amb/runs/`; structured operational
  events live under `logs/amb/`. Both are gitignored.

The first adapter is intentionally labelled **M1 retrieval-only**. AMB documents
are deterministically chunked and loaded as benchmark-scoped episodic entries;
retrieval goes through the same Postgres hybrid provider and revision-safe cache
used by Paw Next. It does not claim to evaluate Paw's future write/distillation
pipeline.

An opt-in M2a atom-ingest ablation is also available. It uses the same DeepSeek
Flash model to extract bounded `semantic / episodic / profile / instruction`
atoms, validates source sequence and conflict target IDs, then writes through
the same deterministic scoped store adapter used by the product writer:

```powershell
$env:PAW_AMB_INGEST_MODE = 'atom'
$env:PAW_AMB_RETRIEVAL_POLICY = 'rrf'
python benchmarks/amb/run_paw_amb.py run `
  --dataset personamem --split 32k --memory paw --mode rag `
  --query-limit 100 --output-dir benchmarks/amb/runs/personamem/paw-m2a-atom-q100
```

`raw_chunk` remains the default so existing M1 results stay comparable. Atom
extraction responses use a separate prompt-hash cache under
`PAW_AMB_LLM_CACHE_DIR/memory-write`; JSONL logs contain hashes, counts, timing,
token usage, and cache settlement only, never document or atom text. Because
atom ingest adds model calls, report its ingestion tokens and latency alongside
answer accuracy.

For PersonaMem, atom mode treats the role-marked transcript as structured
evidence: `[SYSTEM]` persona blocks become verification evidence, `[USER]`
blocks remain user assertions, and `[ASSISTANT]` blocks are excluded rather
than being mistaken for user facts. Selected evidence is packed into bounded
24k-character windows while retaining source sequence and role.

Atom retrieval defaults to `atom_only`. Three opt-in evidence experiments are
available without changing the product runtime:

```powershell
$env:PAW_AMB_ATOM_CONTEXT_MODE = 'source_expand' # atom-linked local turns
$env:PAW_AMB_ATOM_CONTEXT_MODE = 'hybrid'        # L1 atoms + contiguous L0 chunks
$env:PAW_AMB_ATOM_CONTEXT_MODE = 'scene_hybrid'  # L2 scenes + contiguous L0 chunks
$env:PAW_AMB_ATOM_CONTEXT_MODE = 'scene_routed'  # stable L2 index + bounded on-demand reads
$env:PAW_AMB_ATOM_SOURCE_MAX_CHARS = '14000'
$env:PAW_AMB_ATOM_SCENE_MAX_CHARS = '7500'
$env:PAW_AMB_ATOM_SCENE_INDEX_MAX_CHARS = '4096'
$env:PAW_AMB_ATOM_PERSONA_MAX_CHARS = '4000'
```

Atom extraction and the L1/L2 source timeline store only projected SYSTEM/USER
evidence. `source_expand` uses an atom's exact source sequence plus neighboring
turns. `hybrid` keeps L1 atoms as the cross-document index and adds whole,
query-ranked 5k-character L0 chunks under one global character budget. The
conservative `scene_routed` mode additionally keeps an isolated full-transcript
L0 shadow so unsupported routes can exactly reproduce raw retrieval without
writing assistant text into long-term atoms. L0 text never enters operational
logs; only counts, hashes, timing, and total context characters are recorded.
`scene_hybrid` deterministically groups every active L1 atom from each selected
source by evidence sequence, allocates a fair per-source L2 scene budget, and
uses the remaining budget for whole L0 chunks. Scene projection is local and
does not add a model call.

`scene_routed` is the conservative successor experiment. It builds one
scope-and-revision-bound snapshot, keeps a bounded L3 persona and L2
path/summary index separate from scene bodies, and logs their content-free
identity, route, scene-read count, selected atom count, and dynamic character
count. L3 is a deterministic, source-grounded projection of active,
high-confidence profile/semantic claims with a strict size cap and source
diversity. Explicit causal queries may read at most two scene bodies;
recommendation/new-idea queries may read one only when a usable L3 exists.
Ambiguous facts and preference-evolution queries take the raw-safe L0 bypass,
which uses the same RRF, card limit, and token budget as `raw_chunk`.

Atom ingest has fail-closed cost controls. Defaults are 256 paid remote calls,
300,000 prompt tokens, 150,000 completion tokens, and two concurrent user
partitions. A request reserves a conservative prompt upper bound plus all 4,096
possible output tokens before it reaches the provider; cache hits consume none
of these budgets. Override the limits explicitly for a run:

```powershell
$env:PAW_AMB_ATOM_MAX_REMOTE_CALLS = '64'
$env:PAW_AMB_ATOM_MAX_PROMPT_TOKENS = '100000'
$env:PAW_AMB_ATOM_MAX_COMPLETION_TOKENS = '50000'
$env:PAW_AMB_ATOM_CONCURRENCY = '2' # 1..8; each user remains strictly ordered
```

After each successfully applied source window, Paw atomically writes a
hash-only `paw-m2a-atom-checkpoint.v1.json` under the AMB store directory. If a
run is interrupted, rerun the same command with the exact model/config and:

```powershell
$env:PAW_AMB_ATOM_RESUME = '1'
```

Resume suppresses the upstream requested reset, verifies the checkpoint
identity, and skips completed windows. A changed model/extractor identity fails
closed instead of mixing memories. If a crash happens after DB apply but before
checkpoint persistence, the deterministic memory ID and LLM response cache make
the replay idempotent.

Important: `--query-limit` limits evaluated questions, not documents sent to
memory ingest. Use `--doc-limit` for a cheap engineering run, and do not present
that subset as an official comparable score.

For hash-only retrieval attribution, rerun with a dedicated `PAW_AMB_LOG` and
compare returned document-ID hashes with the pinned dataset gold IDs:

```powershell
uv run --project benchmarks/amb/upstream --no-sync -- python `
  benchmarks/amb/analyze_paw_attribution.py `
  --result <run-32k.json> --log <paw-amb-log.jsonl>
```

The generated `attribution.json` contains query fingerprints, gold-document
hit/recall, correctness, and category only. It never copies queries, memories,
answers, or credentials. Retrieval events are joined by both query hash and
user fingerprint so identical query text in two user scopes cannot collide.

Before paying for a larger atom run, exercise one synthetic record end to end:

```powershell
python benchmarks/amb/smoke_paw_atom.py
```

This smoke reads the existing local DeepSeek credential, writes no key to the
command line or logs, and is explicitly not an AMB score.

## Credential-free provider smoke

```powershell
python benchmarks/amb/smoke_paw_amb.py
```

This uses the official packaged PersonaMem 32k artifact, retrieves the same
query twice, verifies the second call hits Paw's cache, and reports whether a
gold source document was recalled. It is not an AMB leaderboard score.

## Official AMB run

The Paw wrapper replaces AMB's hard-coded Gemini startup check and its default
Groq answer model with the configured Paw `deepseekv4flash` credential slot.
The API key remains local and is never copied into results or logs. Install the
pinned environment, then run the wrapper from the repository root:

```powershell
uv sync --project benchmarks/amb/upstream
uv run --project benchmarks/amb/upstream --no-sync -- python benchmarks/amb/run_paw_amb.py run `
  --dataset personamem --split 32k --memory paw --mode rag `
  --query-limit 20 --output-dir benchmarks/amb/runs --name paw-m1-smoke
```

The bridge defaults to the versioned RRF policy. Set the policy explicitly for
an ablation, and keep the deterministic answer configuration and cache directory
the same across both runs:

```powershell
$env:DEEPSEEK_TEMPERATURE = '0'
$env:PAW_AMB_LLM_CACHE_DIR = 'benchmarks/amb/runs/.llm-cache-t0'
$env:PAW_AMB_RETRIEVAL_POLICY = 'legacy' # then repeat with 'rrf'
```

The answer cache key includes the full prompt hash, model/config identity,
cache-policy version, schema, temperature, thinking mode, and reasoning effort.
Retrieval policy is deliberately not duplicated in the key: if two policies
render the exact same prompt, reusing the answer is what makes the retrieval
ablation deterministic and inexpensive. Only successfully parsed JSON responses
are written atomically. Logs contain cache status and token counters, never
prompt/answer text or credentials.

On Windows, the pinned upstream Hindsight dependency requests `uvloop`, which
does not publish Windows builds. Use the Paw-only install path instead:

```powershell
uv sync --project benchmarks/amb/upstream `
  --no-install-package hindsight-all `
  --no-install-package hindsight-api `
  --no-install-package uvloop
```

Remove `--query-limit 20` only after the smoke result and logs have been
reviewed. Publish results only after recording the upstream commit, Paw commit,
adapter label, DeepSeek model ID, and cache statistics. This is a locally
reproducible AMB run; public leaderboard submission may impose additional model
or reproducibility requirements.

## Latest local result

A deterministic first-20 ablation on PersonaMem 32k used
`deepseek:deepseek-v4-flash`, `temperature=0`, and a shared answer cache:

| Retrieval policy | Correct | Accuracy | Avg retrieval | LLM answer cache |
| --- | ---: | ---: | ---: | ---: |
| legacy hybrid | 14/20 | 70.0% | 103.7 ms | 0/20 |
| structured-query RRF | 14/20 | 70.0% | 96.6 ms | 20/20 |

All 20 rendered contexts and answers were byte-for-byte identical. Thus this
slice validates compatibility and the noise-free ablation path, but does not
show a recall gain from RRF. The legacy pass reported 59,136 DeepSeek prompt
cache-hit tokens out of 60,401 prompt tokens (97.9%); the RRF pass made no model
requests because every full prompt hit Paw's local answer cache.

An earlier unpinned-temperature pair produced 70% versus 55% despite identical
contexts; those numbers must not be interpreted as a retrieval regression. This
is still a bounded local integration result, not the complete 589-query public
leaderboard score.

### M2a oracle context ablation

A separate PersonaMem 32k first-20 **oracle** run ingested only the 15 gold
documents for those questions. It is a context-quality diagnostic, not a public
leaderboard score:

| Context mode | Correct | Accuracy | Macro gold-doc recall | Avg context tokens |
| --- | ---: | ---: | ---: | ---: |
| raw chunks | 14/20 | 70.0% | 45% | 2434.5 |
| atoms only | 10/20 | 50.0% | 95% | 329.3 |
| atom-linked split excerpts | 10/20 | 50.0% | 97% | 2490.0 |
| atom-linked neighboring turns | 10/20 | 50.0% | 97% | 2374.5 |
| L1 atoms + contiguous L0 chunks | 13/20 | 65.0% | 97% | 2218.3 |
| L2 source scenes + contiguous L0 chunks | 15/20 | 75.0% | 97% | 2474.0 |

The important diagnosis is that atom-only retrieval found more gold documents
but over-compressed their evidence. Merely making the prompt longer with split
sentences did not help. The contiguous L0/L1 hybrid recovered three atom-only
failures with no correct-to-wrong flips: facts 4/4, preference recommendations
4/4, full preference evolution 3/3, update reasons 1/3, and new ideas 1/6.

The deterministic L2 scene projection then reached 15/20: facts 4/4,
recommendations 4/4, update reasons 3/3, new ideas 2/6, and full preference
evolution 2/3. Relative to the 65% L0/L1 hybrid it recovered three failures and
regressed one prior success; relative to raw chunks it gained three and lost
two. This is a positive net result on the tuned slice, not evidence that the
policy generalizes.

The cold 15-document atom extraction used 15 unique remote writer calls,
48,303 prompt tokens, and 26,020 completion tokens. The final hybrid rerun used
the 15-entry checkpoint and a writer remote-call budget of zero; it stored 307
source blocks and 52 L0 chunks locally. Answer generation had 4/20 local cache
hits and 16 remote calls using 44,335 prompt plus 14,523 completion tokens.
DeepSeek reported zero provider prompt-cache-hit tokens for those 16 varying
answer prompts. The final L2 scene run reused all writer checkpoints, made 19
answer calls plus one local answer-cache hit, and used 57,872 prompt plus 16,431
completion tokens. Provider prompt-cache hits were 3,840 / 57,872 prompt tokens
(6.6%). Validate the scene policy on an untouched query slice before treating
75% as an improvement or paying for a complete leaderboard run.

That holdout gate was run on the untouched queries at offsets 20–24 with their
five oracle documents. Raw chunks scored 4/5 (80%); the frozen scene hybrid
scored 3/5 (60%), with no recovered raw failure and one new fact-recall
regression. The scene context averaged 3,242.6 tokens, 4.6 scenes, 59.4 scene
atoms, and two L0 chunks per query. Writer extraction used 5/5 local response
cache hits and zero remote writer calls; the five new answer prompts used
15,702 prompt and 8,208 completion tokens. Consequently `scene_hybrid` remains
an experimental opt-in, first-100 is stopped, and the tuned 75% result must not
be advertised as a generalized improvement.
An immediate identical rerun reproduced 4/5 versus 3/5 byte-for-byte with all
10 answer prompts served from the local cache and all five atom sources skipped
by checkpoint, so the negative holdout is not sampling noise.

The holdout harness saves no query, context, reasoning, or answer text:

```powershell
uv run --project benchmarks/amb/upstream --no-sync -- python `
  benchmarks/amb/run_paw_holdout.py --offset 25 --count 5 `
  --scene-variant scene_routed `
  --output benchmarks/amb/runs/personamem/paw-m2c-scene-routed-holdout-q25-30.json
```

On offsets 25–29, the first routed policy scored 3/5 versus raw 4/5 while using
one six-atom exploratory scene read. After disabling exploratory reads without
L3, the conservative rerun recovered 4/5 versus 4/5 and reduced average context
from 3,335.0 to 3,152.4 estimated tokens. All five queries fell back to L0/L1,
so this is a regression-guard result, not evidence of L2 accuracy gain. The
writer made zero remote calls (5/5 response-cache hits); the answer rerun had
four local cache hits and one remote 3,118-token prompt with zero provider KV
cache hits.

### M2d L3 persona and raw-safe routing

M2d adds a deterministic L3 persona projection above the stable L2 index. The
projection is query-independent, source-grounded, revision-bound, capped at
4,000 characters, and includes only active high-confidence profile/semantic
claims. The prompt order for routed reads is stable L3 persona, stable L2 index,
bounded scene body, then at most one L0 chunk. No runtime or agent-loop change
is required; all composition remains inside `@paw/memory-plugin` and the AMB
adapter.

The first M2d diagnostic on offsets 25–29 recovered the recommendation that
narrow L2 had regressed: routed and raw both scored 4/5. A new untouched
offset-30–34 gate then exposed a separate fallback bug: preference-evolution
questions used compressed L0/L1 evidence and scored 1/5 versus raw 3/5. Local
chunk selection improved this only to 2/5. The retained fix makes conservative
fallback a true raw-safe bypass: index the complete transcript in a separate L0
scope and pass through the same RRF `maxCards=16` / 4,096-token provider output
without a second wrapper or character cutoff. The offset-30–34 diagnostic then
matched raw exactly, 3/5 with identical per-query context-token counts.

With that policy frozen, the previously unused offsets 35–39 were evaluated.
Raw and routed both scored 2/5 (40.0%) with identical per-query correctness;
average context fell from 3,502.4 to 3,373.8 estimated tokens (-3.7%). Four
queries used the raw-safe bypass. The one L3/L2 exploratory recommendation kept
the correct answer while reducing context from 3,368 to 2,725 tokens (-19.1%),
using one scene, six atoms, and one L0 chunk. This is a five-query oracle
holdout, not a public leaderboard score, and is evidence of regression safety
plus one successful compression case rather than an accuracy improvement.

Cold retrieval caches correctly recorded misses on this new slice. Atom writing
processed ten source windows with nine local response-cache hits and one remote
DeepSeek Flash call (3,626 prompt / 1,414 completion tokens). At answer time,
four of five routed prompts matched raw answers in the local answer cache; the
one new routed prompt used 3,068 remote prompt tokens and had zero provider KV
hits. Raw's five new prompts happened to report 16,256 / 16,522 provider prompt
tokens as cache hits (98.4%). These are different prompt populations, so they
must not be used as a direct KV superiority claim.

### M2n tool-driven progressive retrieval diagnostic

M2n replaces the eager dynamic evidence suffix with a small stable prefix and
read-only memory tools. The initial context contains only the stable L3 persona
and L2 topic index. DeepSeek Flash may then search L1 atoms, read a selected L2
topic, or search/read L0 source evidence. The benchmark adapter uses the same
six-call, 24,000-character session budget as the product plugin and records
content-free tool and token telemetry.

The q68–87 range had already been used by M2m, so this run is a regression
diagnostic rather than an untouched holdout or public leaderboard result:

| Retrieval policy | Correct | Accuracy | Avg initial context | Provider prompt cache |
| --- | ---: | ---: | ---: | ---: |
| raw chunks | 11/20 | 55.0% | 3,304.8 est. tokens | not comparable |
| tool-driven | 14/20 | 70.0% | 1,330.5 est. tokens | 152,576 / 197,866 (77.1%) |

Pairwise, the tool-driven run had ten shared successes, five shared failures,
four recovered failures, and one regression. It executed 49 bridge tool calls
over 26 tool rounds; five additional attempts received a structured budget
exhaustion result. Multi-round prompting raised total answer prompt volume even
though the initial context fell by 59.7%, so the next cost optimization is to
deduplicate repeated L0 drill-down rather than enlarge the stable prefix.

```powershell
uv run --project benchmarks/amb/upstream --no-sync -- python `
  benchmarks/amb/run_paw_holdout.py --offset 68 --count 20 `
  --scene-variant tool_driven `
  --output benchmarks/amb/runs/personamem/paw-m2n-tool-driven-diagnostic-q68-88.json
```

Use q88 or later for the next untouched holdout. Do not combine q68–87 with
earlier development slices or present the 70% diagnostic as an official AMB
score.

### M2o–M2q product-aligned topic tools

The first frozen q88–107 run regressed from raw 11/20 (55%) to tool-driven
10/20 (50%). Its logs exposed an adapter mismatch: tool-driven navigation still
used the legacy source-scene snapshot, while the product plugin read the
cross-session Postgres topic catalog. Both attempted topic reads returned no
document. This range is now a failure diagnostic, not an untouched holdout.

M2o makes the adapter use the product data plane: topic organization during
ingestion, the bounded profile-only L3 projection, the durable L2 topic catalog,
and exact L0 evidence reads. On q109–118, raw scored 5/10 and the aligned tool
path scored 7/10 with no correct-to-wrong flips. All 16 topic reads were
non-empty and average initial context fell from 3,509 to 1,793 estimated tokens.

M2p keeps the full temporal graph in storage but exposes a compact topic body
with trajectory/position ordinals instead of repeated internal relation IDs.
On the untouched q129–138 range, raw scored 6/10 and tool-driven scored 7/10,
with two recoveries and one regression. Initial context fell from 3,510.5 to
1,983 estimated tokens. This ten-query oracle slice is still not an official
AMB score.

M2q adds a budget circuit breaker. Once six executed calls or 24,000 result
characters are consumed, later model rounds no longer receive memory tools.
On the already-seen q135 diagnostic this reduced requests from 10 to 5, rounds
from 3 to 2, and cumulative prompt tokens from 31,145 to 19,865 while retaining
the correct answer. Invalid tool arguments are also returned as structured tool
failures instead of terminating the question.

```powershell
uv run --project benchmarks/amb/upstream --no-sync -- python `
  benchmarks/amb/run_paw_holdout.py --offset 129 --count 10 `
  --scene-variant tool_driven `
  --output benchmarks/amb/runs/personamem/paw-m2p-compact-topic-tools-holdout-q129-139.json
```

### M2r–M2u source attribution and evidence-ledger A/B

Two additional frozen slices showed why a single 70% result was not enough.
On q139–158, raw/tool-driven scored 12/20 versus 14/20. On q159–178 they
scored 14/20 versus 10/20. Combined, the 40-query result is raw 26/40 (65%)
and tool-driven 24/40 (60%), so M2q is not a default-launch accuracy policy.

The bridge now records hash-only source-document attribution. On the q159–178
diagnostic, tool-driven hit at least one gold source on 19/20 queries and had
85% macro gold-source recall, but only 52.6% accuracy conditional on a gold
hit. All five raw-correct/tool-wrong cases had a gold hit. This locates the
main failure after retrieval: evidence consolidation and answer synthesis.

The AMB tool adapter was also dropping the product fields needed to use that
evidence. It now returns product-shaped `evidence`, `topics`, `states`, and
`spans`, preserving memory IDs, source references, status, and time. On the
same diagnostic range this moved tool-driven from 11/20 (55%) to 13/20 (65%)
against raw 14/20 (70%); conditional accuracy after a gold hit rose to 61.1%.

An experimental session evidence ledger removes repeated items across
overlapping tool calls. It remains opt-in. On the new q179–188 gate, ledger-off
scored raw 4/10 versus tool 8/10 with four recoveries and zero regressions.
Ledger-on also scored 8/10, but prompt volume increased from 142,896 to 166,707
tokens (+16.7%), calls from 32 to 36, and rounds from 13 to 16 despite removing
47 repeated items. The ledger therefore does not ship as the product default;
the next architecture target is a source-grounded L2 conclusion/evolution/
conflict projection rather than more retrieval or category-specific routing.

The holdout runner truncates only its exact per-variant JSONL log before each
run, preventing repeated offsets from contaminating attribution. Topic
organization failures are content-free logged and fail open, matching the
product plugin boundary.

### M2v–M2w persona-disjoint evaluation and writer repair

The earlier consecutive-offset holdouts are not persona-independent. PersonaMem
defines `gold_ids` as every session before the question cutoff, not as exact
support evidence. Loading the union for several questions from one persona can
also expose a later question's history to an earlier question because the Paw
bridge does not apply `query_timestamp` filtering. In addition, raw retrieval
does not see MCQ options while the tool agent sees the full prompt and receives
extra search/reasoning rounds. Consequently source-document hit cannot be used
as exact evidence recall, and raw versus tool is not a controlled architecture
comparison.

`persona_holdout_plan.py` now creates a content-free deterministic split that
excludes every persona seen in specified development ranges and selects exactly
one query per remaining persona. The frozen 32k plan excludes q0–188 (13
personas), allocates 6 unseen personas to `dev`, 12 to sealed `test`, and leaves
6 unused. Query text, answers, document IDs, and raw persona IDs never enter the
plan. `run_paw_persona_holdout.py` validates all hashes before execution, loads
each selected persona's complete pre-query history, exposes per-variant
checkpoints, and reports total LLM/tool usage. `tool_l0` uses the same agent loop
but exposes only `memory_search_conversation`, with an empty initial context.

The first six-persona development comparison is:

- raw chunk: 4/6, 18,334 prompt tokens, no tool calls;
- L0-only tool loop: 3/6, 38,247 prompt tokens, 14 tool requests / 7 rounds;
- current L1/L2 tool path: 4/6, 153,459 prompt tokens, 27 tool calls / 15 rounds.

Raw and current L1/L2 are correct on exactly the same four queries, so this
development slice shows regression safety but no accuracy gain. L0-only has one
recovery and two regressions, showing that extra search rounds alone are not an
accuracy solution. Provider-side prompt-cache ratios on this replay were 97.7%,
29.5%, and 60.6% respectively; the raw control was already warm at the provider,
so cache-miss tokens are not a cold-start comparison. Total prompt volume still
shows that the existing tool path is too expensive for accuracy parity.

During the run, one writer response exceeded the 16-atom contract. The generic
plugin extractor now performs one validation-driven re-extraction using a
separate repair-policy prompt; it never truncates the 17th atom or commits an
invalid response. A second invalid proposal still fails closed. On the clean
rerun, all 34 documents completed, one repair call was required, and topic
organization completed for 33 non-empty projections without a bridge failure.
The next architecture experiment is a source-grounded L2 dossier returned in
one bounded read, not a larger top-k or more free-form tool rounds. The 12-persona
test partition remains unopened.

Artifacts:

- `runs/personamem/paw-m2v-persona-disjoint-plan.json`
- `runs/personamem/paw-m2w-persona-disjoint-dev-controls.json`
- `runs/personamem/paw-m2w-persona-disjoint-dev-tool.json`
- `runs/personamem/paw-m2w-persona-disjoint-dev-analysis.json`

### Facet V2 persona shadow evaluation

`run_facet_persona_holdout.py` evaluates the shadow-only Facet V2 projection
against the same frozen persona-disjoint plan and an existing content-free
baseline. It writes one diagnostic Facet report per persona, one content-free
aggregate result, a resumable checkpoint, and JSONL lifecycle logs. The default
path uses only Facet query evidence. `--verify-support` additionally runs the
existing option-aware coverage planner, exact L0 hydration, and support verifier;
it is a diagnostic ablation, not the product default.

```powershell
uv run --project benchmarks/amb/upstream --no-sync -- python `
  benchmarks/amb/run_facet_persona_holdout.py `
  --plan benchmarks/amb/runs/personamem/paw-m2v-persona-disjoint-plan.json `
  --partition test `
  --baseline benchmarks/amb/runs/personamem/paw-m3y-frozen-m3-persona-disjoint-test.json `
  --output benchmarks/amb/runs/personamem/paw-facet-v2-persona-test.json `
  --limit 4
```

The first frozen four-persona gate scored 1/4 for Facet versus 2/4 for the M3
tool-driven baseline. Adding decision evidence and strict L0 support verification
did not change any answer, while increasing average context from about 2.5k to
5.0k characters and adding two model calls per query. The support reports showed
that several wrong MCQs had multiple alternatives directly supported by the
persona history. These results are a negative architecture gate: Facet remains
shadow-only and support verification remains opt-in.

## Optional local dense ablation

DeepSeek's public API does not expose an embedding model. A benchmark-only local
OpenAI-compatible endpoint is provided so dense retrieval can be measured while
the answer model remains DeepSeek Flash:

```powershell
uv run --project benchmarks/amb/upstream --no-sync -- `
  python benchmarks/amb/local_embedding_server.py

$env:PAW_AMB_RETRIEVAL_POLICY = 'rrf'
$env:PAW_AMB_EMBEDDING_MODE = 'hybrid_partitioned'
$env:PAW_AMB_EMBEDDING_BASE_URL = 'http://127.0.0.1:18081/v1'
$env:PAW_AMB_EMBEDDING_MODEL = `
  'sentence-transformers/all-MiniLM-L6-v2-window-mean-180+zero-pad-1536'
$env:PAW_AMB_EMBEDDING_VERSION = 'window-mean-v1'
$env:PAW_AMB_EMBEDDING_DENSE_DIMENSIONS = '384'
$env:PAW_AMB_EMBEDDING_DENSE_WEIGHT = '0.1'
```

When `--reuse-index` is enabled, the bridge verifies every expected L0 source
span and chunk ID before ingestion is skipped. For each enabled dense index
level it also requires a vector written by the exact configured embedding
model/version. The check is logged as `reuse_index_validation`; any missing
entry or current-version vector aborts reuse rather than silently degrading to
lexical retrieval.

Release protocol v4 also makes cache cost reproducible. Local response caches
store a versioned usage envelope instead of only the model text. Reports expose
actual remote tokens, the origin tokens represented by local cache hits, and
provider prompt/KV-cache hit tokens as separate counters. A release gate fails
closed if any local cache hit lacks origin usage; treatment is capped at 50%
context growth, 2 memory-semantic calls per query, and 4,000 memory-semantic
workload tokens per query.

The helper windows long memories into 180-word segments with 30-word overlap,
mean-pools normalized 384-dimensional MiniLM vectors, then zero-pads them to the
current 1536-dimensional pgvector schema. Zero-padding preserves cosine
similarity. The endpoint and Paw adapter log only hashes, counts, identity,
dimensions, status, and timing.

Pure windowed dense+RRF scored **12/20 (60.0%)**, versus **14/20 (70.0%)**
for the n-gram baseline. A lexical candidate-count gate correctly avoided dense
when lexical recall was full, but broad OR lexical retrieval also scored 60% and
was reverted.

The retained optimization uses a partitioned hybrid vector: the first 384
coordinates carry dense similarity and the remaining 1152 carry n-gram
similarity. The two normalized subspaces are scaled so cosine similarity is
exactly `0.1 * denseCos + 0.9 * ngramCos`. This recovered **14/20 (70.0%)**.
Twelve of 20 contexts changed while all 20 answers remained the same as the
baseline, so dense was active without regressing this slice. Average retrieval
was 181.9 ms; 15 query embeddings were generated and five repeated queries hit
the process cache. It remains opt-in because it recovered, but did not exceed,
the bounded baseline.

`rebalance_partitioned_embeddings.ts` can rescale the two disjoint subspaces in
the isolated AMB repository without re-sending text to the embedding model. It
requires an explicit `amb-personamem-*` repository ID and updates model version
and index revision transactionally.

## M3 complete-dialogue L0 development result

The memory writer now archives complete user/assistant dialogue in L0 while
treating assistant text as context-only evidence. Query resolution performs a
bounded L0 audit for every required discriminant, retrieves old exact-term
candidates in addition to the recent window, and preserves an adjacent user
confirmation after an assistant hit. The V3 product context and memory tools
share one session-pinned resolver result.

On the already-open six-persona development partition, a full clean ingest run
scored 5/6 (83.3%), up from the earlier 3/6 resolver baseline. A later
read-side-only replay against that same store scored 6/6 after the generic L0
ranking and adjacent-confirmation changes. The latter used 41,576 answer prompt
tokens, 5,316 completion tokens, and one lower-level memory-tool call. These are
small public-development diagnostics, not an AMB leaderboard score and not a
substitute for the sealed persona-disjoint test partition.

Artifacts:

- `runs/personamem/paw-m3q-complete-dialogue-l0-persona-disjoint-dev.json`
- `../../logs/amb/paw-m3q-complete-dialogue-l0-persona-disjoint-dev-dev-tool_driven.jsonl`
- `../../logs/amb/paw-m3x-six-query-replay.jsonl`

## M3 frozen persona-disjoint test

The sealed 12-persona test partition has now been opened after the M3 read
strategy was frozen. Tool-driven M3 scored **7/12 (58.3%)** while the same
DeepSeek Flash model on raw-chunk retrieval scored **1/12 (8.3%)**. Pairwise,
there was one common success, five common failures, six tool recoveries, and no
tool regression. This is a project-local evaluation on public PersonaMem data,
not a public AMB leaderboard submission.

The first atom run stopped after 34 completed evidence windows because a repaired
model response padded its proposal with empty `skip` rows. The generic extractor
now treats only the exact empty skip shape as omission; every non-empty proposal
retains strict schema and evidence validation. The run resumed from its original
checkpoint and completed 62 history documents / 88 evidence windows.

Writer cost must be aggregated across both process segments: 294 remote calls,
1,132,113 prompt tokens, 221,819 completion tokens, and six local response-cache
hits. Provider-side cached prompt tokens were 90,240 (8.0% of writer prompt
tokens). Query/result cache hits were zero because all 12 personas and questions
were disjoint. The tool answer phase used 106,974 prompt and 16,849 completion
tokens with two lower-level memory-tool calls; raw used 36,794 and 16,758.

Error review found one concrete temporal-coreference gap: an earlier negative
`online investment forum` state and a later positive `online investment
community` state were kept in separate trajectories. It also found benchmark
noise in an item whose gold option refers to `stereotypical`, while the complete
user history says only `dry`, `tedious`, and `unengaging`. Scores above retain the
official gold without manual correction.

Artifacts:

- `runs/personamem/paw-m3y-frozen-m3-persona-disjoint-test.json`
- `runs/personamem/paw-m3z-frozen-m3-persona-disjoint-test-raw-control.json`
- `../../logs/amb/paw-m3y-frozen-m3-persona-disjoint-test-test-tool_driven.jsonl`
- `../../logs/amb/paw-m3z-frozen-m3-persona-disjoint-test-raw-control-test-raw_chunk.jsonl`
