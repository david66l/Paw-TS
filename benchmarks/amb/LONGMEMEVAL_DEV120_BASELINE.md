# Paw Memory LongMemEval-S 84.17% Development Baseline

Status: **official Paw project baseline; not a public leaderboard claim**.

The immutable Git tag
`memory-longmemeval-dev120-84.17-baseline` points to clean commit
`a7ad6b5168544a27d16ce9a679273cf04a457668`. The content-free machine record is
[`baselines/longmemeval-dev120-84.17.json`](./baselines/longmemeval-dev120-84.17.json).
Generated run files and the per-query sealed ledger remain private and
gitignored.

## Result

The run evaluated 120 persona-disjoint LongMemEval-S queries, with 20 queries
from each of the six question types. It used the complete prebuilt dense index,
`k=8`, the upstream answer protocol, DeepSeek Flash, answer tools, no answer
review, and a content-free post-run error audit.

| Metric | Result |
| --- | ---: |
| Answer accuracy | 101/120 (84.17%) |
| Gold-source hit rate | 97.37% |
| Macro gold-source recall | 94.11% |
| Mean reciprocal rank | 87.73% |
| Evidence-closure rate | 72.50% |
| Incorrect despite reported closure | 10 |
| Average rendered context | 1,459 tokens |
| Average retrieval time | 1,636 ms |

| Question type | Correct | Accuracy |
| --- | ---: | ---: |
| Single-session user | 20/20 | 100% |
| Single-session assistant | 15/20 | 75% |
| Multi-session | 14/20 | 70% |
| Temporal reasoning | 14/20 | 70% |
| Knowledge update | 20/20 | 100% |
| Single-session preference | 18/20 | 90% |

## Architecture that produced the score

The retained system is a bounded L0/L1 evidence compiler, not the full
experimental L0-L3 graph architecture:

1. Immutable L0 dialogue turns and chunks preserve role, order, time, and an
   exact evidence address.
2. Derived L1 atomic memories provide navigation only. A final factual packet
   must hydrate back to L0.
3. A deterministic classifier separates answer shape, temporal mode, and role.
4. A bounded model planner expands complex questions into at most four evidence
   requirements.
5. Lexical and dense retrievers produce L0 chunks, L0 spans, conversation spans,
   and L1 navigation candidates. Rank-only fusion selects at most eight sources.
6. The source set is locked. A model selector may bind only supplied evidence
   addresses to requirements; it cannot widen scope or invent evidence.
7. Deterministic code builds a bounded notebook, applies role and temporal
   policy, and emits a canonical answer contract plus exact L0 evidence.
8. The answer model receives that packet and may use bounded read-only memory
   tools. Error audit is diagnostic and does not change answers.

Scope identity, evidence IDs, source budgets, chronology, cache identity, and
packet construction are code-owned. Models handle semantic decomposition,
address selection, and final language generation.

## What the 19 errors actually show

The failures are concentrated rather than uniformly distributed:

- Seventeen of nineteen errors are assistant recall, multi-session, or temporal
  questions. Direct user facts and knowledge updates are 40/40.
- Of the seventeen answerable errors, ten already recalled every gold document,
  four recalled part of the gold set, and only three recalled none. The main
  bottleneck is therefore exact turn binding inside a known source, not broad
  document discovery.
- Wrong answers used 1,266 context tokens on average versus 1,495 for correct
  answers, while both groups selected the maximum eight sources. Increasing the
  source count or blindly adding context does not address the observed gap.
- Multi-session and temporal questions represented by one requirement were
  correct on 14/23 (60.9%). The same categories with two requirements were
  correct on 13/15 (86.7%). Under-specified evidence obligations are a major
  failure mode.
- Four of five assistant-recall errors had complete gold-document recall. The
  missing capability is target-turn topology: distinguishing user prompts,
  assistant outputs, user corrections, and revised assistant outputs inside a
  conversation.
- Ten wrong answers were marked evidence-closed; seven of those were later
  diagnosed as missing relevant evidence. Planner coverage plus selector success
  is not an independent closure certificate.
- Both unanswerable failures were multi-session questions, and one was marked
  closed. The architecture does not yet represent a bounded proof of absence.
- Six wrong answers used the deterministic direct certificate. It is useful as
  a planner-cost hint, but its observed 83.3% accuracy does not justify treating
  it as semantic proof.

The disjoint repair-stage attribution is: retrieval 10, evidence selection 2,
answer synthesis 4, and evaluation 3. Error causes are missing relevant
evidence 13, answer format or scope 2, distractor/conflict 1, and judge mismatch
3.

## Missing capabilities and architectural response

### 1. Evidence-obligation compiler

Replace the current loose planner checklist with typed answer slots. Operands,
time anchors, target role, requested output, and absence claims become explicit
obligations. The model may propose obligations, but code validates that the
question's named operands and immutable intent axes are represented. A direct
certificate may save planner cost only after this structural check; it cannot
serve as closure proof.

Expected impact: multi-session and temporal questions currently collapsed into
one broad requirement.

### 2. Two-stage source and span retrieval

Separate coarse source discovery from source-local evidence retrieval. After
locking sources, run a filtered lexical+dense turn search independently for
each obligation and source. Return a small role-aware candidate set per
obligation. Do not scan all turns into the prompt and do not let global RRF
choose sources and answer spans in one step.

Expected impact: the six missing-evidence errors that already had complete
gold-document recall, plus assistant target-turn failures. This stage is
deterministic retrieval and should not add an LLM call.

### 3. Dialogue topology projection

Represent a selected assistant turn with its bounded local structure: preceding
user request, assistant output, subsequent user feedback, and revised assistant
output. Preserve exact roles and sequence. The selector chooses a target turn;
the packet supplies only the minimum adjacency needed to interpret it.

Expected impact: assistant recall, role attribution, and revised-output cases.

### 4. Code-owned closure certificate

Compute closure from the obligation-to-evidence matrix, independently of the
model selector. Every obligation needs role-correct L0 support; comparisons and
aggregates need every operand; temporal questions need the required ordered
observations; convergent inferences need distinct events; absence requires a
bounded search-completeness certificate. Unresolved obligations remain partial.

An optional model audit may challenge a high-risk certificate, but it is not
the primary closure mechanism and cannot add facts or sources.

Expected impact: reduce incorrect closed answers from 10 to at most 3 without
lowering retrieval recall.

### 5. Typed answer execution

Bind answer operations to explicit slots rather than giving the answer model a
generic evidence list. Code should handle safe date ordering, latest-state
selection, deduplication, and simple counts. The model performs only the
remaining language synthesis and returns the requested value or a bounded
abstention. Read-only answer tools should open only when the initial packet is
partial and a named obligation remains unresolved.

Expected impact: four synthesis failures, two unanswerable cases, and lower
tool-call cost.

## What not to retain from post-baseline experiments

Post-baseline trials are diagnostic, not promoted results:

- Adding an independent closure auditor reduced false closure but did not
  improve the 30-query score by itself.
- Blindly scanning many turns inside selected sources increased candidates and
  could introduce answer distraction. Source-local retrieval must be filtered
  per obligation at the index, not implemented as prompt expansion.
- A second answer-review call attempted 17 reviews, changed no answer, and left
  accuracy unchanged. It is not cost-effective as a default layer.

These observations rule out more prompts, larger contexts, and unconditional
second-pass models as the main strategy.

## Implementation and evaluation gates

Implement capabilities in this order: obligation compiler, filtered source-local
turn retrieval, dialogue topology, closure certificate, then typed answer
execution. Each phase must have synthetic capability tests before touching a
new benchmark holdout.

Promotion over this baseline requires all of the following:

- no regression in the 40/40 direct-user and knowledge-update categories;
- gold-source hit rate at least 97.37% and macro recall at least 94.11%;
- incorrect evidence-closed answers at most 3/120;
- average context no more than 1,678 tokens (+15%);
- memory remote calls no more than 2 per query and memory workload no more than
  4,000 tokens per query;
- at least 103/120 (85.83%) on a frozen unseen development holdout before a
  full 500-query run;
- a frozen full-split result above the comparison target before any public
  superiority claim.

The inspected 120 rows are now an error-analysis set, not an unseen holdout.
Architecture choices should be developed against synthetic variants of these
capability failures, then evaluated once on a separately sealed split.
