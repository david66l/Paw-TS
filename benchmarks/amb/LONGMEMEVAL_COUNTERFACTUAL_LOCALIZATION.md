# LongMemEval-S Counterfactual Failure Localization

Status: **completed diagnostic on the 19 known errors from the 84.17%
development baseline; not a benchmark score or leaderboard claim**.

The diagnostic harness is commit `3c5e12b5f3dfcc5b790473dccde99d2b4f27a8f5`.
Production retrieval was executed from the frozen baseline commit
`a7ad6b5168544a27d16ce9a679273cf04a457668`. The run reused the completed
500-user index and did not rebuild or write memory.

## Question

The baseline error profile suggested that correct documents were often found
without the right evidence reaching the answer. That observation did not
distinguish among four causes:

1. source discovery selected the wrong conversations;
2. the right source was selected but the right turns were absent;
3. irrelevant sources distracted the answer model;
4. the answer model failed despite an adequate packet.

The study changes one evidence condition at a time while keeping the answer
model, judge, temperature, and answer-tool policy fixed. Answer tools are off so
an arm cannot silently perform a second retrieval.

## Conditions

| Condition | Evidence presented to the answer model |
| --- | --- |
| `current_packet` | Frozen production retrieval, upstream answer prompt |
| `current_gold_filtered` | Current packet with non-gold sources removed; declared post-hoc discriminator |
| `source_locked` | Gold sources, then query-only dense/lexical/role-aware local turn ranking |
| `oracle_span` | Gold sources, then answer-aware local turn ranking; accepted answers are used only to rank hidden turns and are never placed in answer context |
| `structured_synthesis` | Current packet with Paw's structured evidence answer protocol |

Every arm writes only case ordinal, question type, condition, correctness,
counts, timings, token estimates, and hashes. No question, accepted answer,
candidate answer, conversation, retrieved text, query HMAC, seed, or credential
is written to the event log or public result.

## Result

| Condition | Correct | Paired wins | Paired losses | Net vs current | Average context |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current packet | 7/19 (36.8%) | - | - | - | 1,301 tokens |
| Current gold-filtered | 5/19 (26.3%) | 1 | 3 | -2 | 415 tokens |
| Source-locked local turns | 11/19 (57.9%) | 6 | 2 | +4 | 1,464 tokens |
| Oracle-span local turns | 11/19 (57.9%) | 6 | 2 | +4 | 1,020 tokens |
| Structured synthesis | 5/19 (26.3%) | 0 | 2 | -2 | 1,301 tokens |

The predeclared diagnostic rule required the oracle-span arm to complete all 19
cases and net at least four wins over the current packet. It met that rule.
This is evidence for the turn-localization hypothesis, not a statistically
conclusive benchmark result: the exact two-sided paired test for six wins and
two losses is `p=0.289` on this small, deliberately error-selected set.

The post-hoc discriminator is more informative architecturally. Merely removing
non-gold sources lost two net answers, while re-reading the gold sources and
ranking their turns gained four. Source-local turn ranking beat gold-filtering
by seven wins to one loss. The missing capability is therefore not generic
distractor removal. The current packet often lacks enough useful content from a
relevant source; deleting its remaining context makes that worse.

The query-only and answer-aware local rankers produced identical correctness
labels on all 19 cases even though their generated answers usually differed.
The accepted-answer locator added no measured accuracy. A production design
does not need answer-aware or benchmark-specific evidence selection.

## Where the gain occurred

| Question type | Cases | Current | Gold-filtered | Source-local | Oracle span | Structured synthesis |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Single-session assistant | 5 | 2 | 1 | 5 | 5 | 2 |
| Multi-session | 6 | 3 | 3 | 2 | 2 | 2 |
| Temporal reasoning | 6 | 1 | 1 | 2 | 2 | 1 |
| Single-session preference | 2 | 1 | 0 | 2 | 2 | 0 |

Assistant recall is the clearest signal: source-local retrieval repaired all
five known failures from this category, improving three cases over the paired
current packet. Multi-session performance moved in the opposite direction.
This rules out replacing the existing packet globally with a narrow local-turn
packet.

## Architectural decision

Retain the existing source fusion, planner, selector, and broad multi-source
packet. Add one small optional port rather than another memory layer:

```text
locked candidate sources
        + typed requirement
        + role/time constraint
                 ↓
       SourceLocalEvidenceLocator
                 ↓
top role-correct turns + bounded dialogue neighbors
                 ↓
merge with the existing packet under the same evidence budget
```

The locator should:

- query the existing turn index with a hard source-ID filter;
- operate once per evidence requirement, not scan every source into a prompt;
- apply the assistant/user role constraint before ranking;
- preserve the target turn plus only the adjacency needed for request,
  correction, or revision interpretation;
- add no LLM call and expose only immutable L0 evidence addresses;
- supplement the current packet for assistant recall rather than replace the
  broad packet used by multi-session reasoning.

Planner completeness remains a separate likely gap for multi-session and
temporal questions. The present experiment does not justify implementing a new
planner, closure LLM, answer review, or deterministic answer executor first.

## Limitations

- These 19 cases were chosen because the baseline got them wrong. They cannot
  estimate the accuracy of a new system or support a public superiority claim.
- The paired current rerun answered 7 of the 19 old errors correctly. Retrieval
  planning, generation, and judging are model-mediated even at temperature
  zero, so regression to the mean and provider nondeterminism are visible.
- Perfect gold-source locking is an oracle condition. A production locator can
  only search sources discovered by the existing fusion.
- The small paired sample has insufficient power. The result chooses the next
  capability experiment; it does not promote an architecture.

## Falsifiable next gate

Before another LongMemEval score run:

1. add synthetic assistant request/correction/revision fixtures and require at
   least 90% target-turn Recall@4;
2. implement `SourceLocalEvidenceLocator` behind the standalone plugin port;
3. on this analysis set, require at least three assistant-recall repairs, no
   assistant regression, and no multi-session use of the replacement path;
4. keep average rendered context within 15% of the 84.17% baseline and add no
   remote model call;
5. evaluate once on a separately frozen, unseen holdout before changing the
   official baseline.

## Artifacts and logs

The local content-safe artifacts are intentionally gitignored:

- `benchmarks/amb/runs/longmemeval/paw-counterfactual-localization-dev19-v2.json`
  (`sha256:b829be6c44b1595350e6582d157a81d5bb13ffcc3d3705b0ace5c4cfab930382`)
- `benchmarks/amb/runs/longmemeval/.sealed/paw-counterfactual-localization-dev19-v2-ledger.json`
  (`sha256:287ab34311580263671357aaabbd0bda030cf5bd24295724cb70801d46d2791c`)
- `logs/amb/paw-counterfactual-localization-dev19-v2.jsonl`
  (`sha256:1e3844e33b9c9b3aaba28c7ab53b08d3b3c8c0b8a9816d92f12c39f3690e03d8`)

The v2 run made zero remote memory-planning calls: all 31 memory LLM requests
were replay-cache hits. Across 95 answer arms, 80 answer calls and 82 judge calls
were cache hits; only the post-hoc discriminator required material new work.
