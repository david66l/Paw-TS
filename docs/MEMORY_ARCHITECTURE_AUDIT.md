# Paw Memory Architecture Audit

Status: active design review. Full benchmark runs stay paused until the gates
in this document pass.

## 1. What a good memory system must preserve

Paw should not copy biological vocabulary. A cognitive principle is useful
only when it changes a data structure, state transition, test, or metric.

| Cognitive finding | Engineering consequence in Paw |
| --- | --- |
| Complementary learning systems use fast episodic storage and slower semantic integration | Capture immutable L0 episodes first. Build L1 claims and later projections asynchronously and reversibly. |
| Event boundaries improve later recall | Preserve run, segment, turn, role, source, and time boundaries instead of flattening a conversation into one summary. |
| Encoding specificity makes retrieval cues important | Keep lexical, semantic, entity, temporal, and source-local addresses; do not expect one embedding to answer every query shape. |
| Source monitoring is part of remembering | Role, authority, ownership, provenance, and exact evidence addresses are first-class fields. |
| Retrieval can update a memory representation | Version derived state and relationships. Never rewrite the immutable evidence that justified an earlier state. |
| Working memory is bounded | Compile a small, query-specific evidence notebook rather than injecting the whole store. |
| Forgetting can reduce interference | Decay or rebuild derived indexes and ranking signals. Do not silently delete L0 audit evidence by default. |

Primary references: [Complementary Learning Systems](https://pubmed.ncbi.nlm.nih.gov/22141588/),
[event segmentation](https://pmc.ncbi.nlm.nih.gov/articles/PMC3314399/),
[episodic buffer](https://pubmed.ncbi.nlm.nih.gov/11058819/),
[source monitoring](https://pubmed.ncbi.nlm.nih.gov/8346328/), and
[reconsolidation](https://pubmed.ncbi.nlm.nih.gov/10963596/).

## 2. Minimal target architecture

The correctness core has four components:

1. **Immutable episode store (L0).** Every stable terminal episode is recorded
   with scope, source, role, turn order, and observation time. Capture does not
   depend on whether an LLM decides to extract a memory.
2. **Derived navigation (L1).** Atomic claims, keywords, embeddings, and entity
   links help find L0. They are not answer evidence by themselves and may be
   rebuilt.
3. **Versioned state reducer.** Explicit updates create a lineage and a current
   view while retaining history, ambiguity, and provenance.
4. **Query-time evidence compiler.** The question becomes typed evidence
   obligations. Retrieval discovers sources, source-local lookup binds exact
   turns, a bounded notebook checks coverage, and only hydrated L0 is exposed
   to answer synthesis.

Topic dossiers, personas, aspect graphs, scenes, and reflections are optional
asynchronous projections. They may improve navigation, but the answer must
remain correct when they are absent, stale, or rebuilding.

## 3. Current audit findings

### Correct foundations already present

- Scope is explicit and enforced at storage boundaries.
- L0 rows are content-hashed and immutable by evidence address.
- L1 claims retain exact L0 references and are treated as navigation.
- Conflict resolution writes the replacement before invalidating the old
  claim, and persists `supersedes` lineage.
- The read path separates source discovery, exact turn localization, support
  selection, notebook construction, and packet rendering.
- Assistant text has lower authority unless a dialogue certificate binds it to
  user-confirmed context.
- Caches are versioned by model/config/source revisions rather than query text
  alone.

### Defects fixed in this audit

1. **L0 capture was incorrectly gated by L1 extraction.** Ordinary dialogue
   was discarded unless it contained an explicit memory phrase or a verified
   task mutation. The writer now records stable episodes before deciding
   whether semantic extraction should run. A skipped or failed L1 write no
   longer loses the experience.
2. **LongMemEval abstention was judged with the wrong rubric.** The runner now
   recognizes the official `_abs` rule and uses the dedicated unanswerable
   rubric.
3. **Retrieval gold used the wrong authority.** Session recall now uses
   `answer_session_ids`; `has_answer` remains a turn-level diagnostic label.
4. **Duplicate session IDs collided physically.** Every physical session now
   gets a collision-free ID and is mapped back to the official logical ID only
   for metrics.
5. **Reader order confused relevance with time.** Retrieval rank remains the
   retrieval metric, while the answer reader receives sessions in chronological
   order, matching the official generation protocol.
6. **Planner completeness was advisory instead of enforced.** A deterministic
   obligation compiler now declares only the proof shape: independent operand
   count, total evidence floor, and content-free reason codes. Model plans that
   under-decompose a comparison, calculation, coordinated question, explicit
   interval, or longitudinal request are rejected at the port boundary.
7. **Closure repair could escape its evidence aperture.** One repair is now
   allowed only inside the source set locked by the first pass. It cannot call
   global discovery or alter source fusion, and a second audit with zero repair
   budget decides the final verdict.
8. **Lexical rank dominance was incorrectly treated as a proof.** The former
   direct-certificate shortcut could close a lookup merely because one source
   ranked above another, even though it produced no semantic witness. It has
   been removed. Every query now enters the same obligation, planning, exact
   evidence binding, and support-selection path.
9. **Requirement bindings weakened at the answer boundary.** The resolver now
    publishes one typed ledger entry per requirement with disjoint supporting,
    candidate, and contradicting evidence refs. The answer contract preserves
    that ledger instead of reducing it to counts, and retained structural
    evidence remains associated with its requirement. Serialization filters
    every address against evidence actually present in the packet, so control
    metadata cannot point to hidden text or grant candidate closure credit.
10. **Closure verification and retrieval planning shared one model-owned
    contract.** The verifier emits only reason-coded deficiencies and evidence
    rejections. The planner consumes that report and returns one
    complete replacement plan instead of appending model-authored requirements.
    The second pass re-evaluates the new plan against all bounded evidence in
    the locked source aperture, and an empty repaired packet settles as
    insufficient without making an invalid verifier call. An earlier strict
    gate exposed that free-form verifier prose remained an unreliable machine
    contract even with a separate length budget. The verifier-to-planner
    boundary therefore carries only a reason code plus an
    optional existing requirement ID. Query-level omissions use a null target,
    repeated codes preserve missing-slot cardinality, and only the planner may
    author natural-language labels or search text. This removes free-form model
    prose from the inter-module protocol rather than repeatedly raising a
    length limit. The reason-coded contract remains subject to the fixed
    dev120 gate.

### Rejected experiments

- **Directly rendering structurally valid but semantically unknown local
  candidates.** On the paired fixed dev120 gate this changed 18 answers: eight
  errors became correct, but ten correct answers regressed. Overall accuracy
  moved from 87/120 to 85/120, average retrieval latency increased by more than
  seven times, and losses spread across five question categories. The behavior
  was removed. A future candidate recovery path must verify support before the
  answer boundary; the reader must not double as an evidence selector.

### Open architectural defects

1. **Product and benchmark locator profiles differ.** Both use the shared
   evidence resolver, but the benchmark source-local locator uses lexical and
   dense RRF over a dedicated turn index. The product Postgres archive locator
   is lexical-only and has smaller budgets. A research score must not be called
   product-parity until an explicit profile-equivalence gate passes.
2. **Selector failure is fail-closed but only partly availability-safe.**
   Deterministically certified simple L0 lookups no longer call the selector.
   Complex queries still close every candidate when semantic selection fails;
   they must not be silently promoted by a lexical fallback.
3. **Optional projections are too close to the synchronous write path.** Topic
   organization and dossier projection add code and model work even though the
   retained evidence-first read path does not require them for correctness.
4. **L1 consolidation is trigger-narrow.** Explicit preferences and verified
   task outcomes are captured, but novel ordinary facts remain L0-only. This is
   safe after the L0 fix, but later consolidation should be driven by explicit
   intent, recurrence, novelty, or retrieval pressure rather than more regexes.
5. **Ingestion resume is correct but unnecessarily expensive.** The atom
   checkpoint prevents duplicate logical writes, but a resumed run still
   replays complete L0 blocks and their embeddings before reaching unfinished
   documents. A document-level durable ingest manifest must sit ahead of L0
   prewarm so recovery is proportional to remaining work.
6. **Benchmark storage identity is coupled to an output path.** The bridge
   derives its storage scope from `output.parent`, so the same explicit store
   key silently addresses an empty index when a comparison writes results to a
   different directory. Storage namespace must become an explicit immutable
   input; result paths and cache paths should not participate in memory
   identity.

## 4. Evaluation must localize failures

A single LongMemEval accuracy number mixes storage, retrieval, packet building,
answer synthesis, and judging. Paw must pass these gates in order:

| Gate | Question answered | Required evidence |
| --- | --- | --- |
| G0 Protocol | Are the 500 questions, abstentions, IDs, dates, gold sessions, prompts, and judge identity correct? | Content-free protocol audit and manifest |
| G1 Capture | Did every stable episode and turn reach L0 exactly once without depending on L1? | Episode count, role/order coverage, idempotency test |
| G2 Derivation | Do L1 claims cite existing L0 and preserve update lineage? | Referential integrity and replay tests |
| G3 Retrieval | Are official gold sessions and annotated answer turns found? | Session recall, turn recall, MRR, source-local recall |
| G4 Packet | Did the notebook bind every requested operand to authoritative evidence? | Requirement coverage, oracle-span sufficiency, false-closure rate |
| G5 Reader | Can the answer model solve the item when given oracle evidence? | Oracle-reader accuracy by type |
| G6 Judge | Does the configured judge agree with the official rubric and a frozen human sample? | Agreement rate and disagreement audit |
| G7 End to end | Does the complete frozen profile improve without hiding regressions? | Dev gate first, then one sealed 500-question run |

Failure attribution is exclusive: protocol, capture, source discovery, exact-turn
binding, obligation/closure, reader, or judge. A change advances only when its
target gate improves without violating an earlier gate.

The frozen 500-question baseline makes this ordering measurable: 82 of its 112
incorrect answers already had complete official-session recall. The dominant
ceiling is therefore downstream of global source discovery. Work on source
ranking alone cannot plausibly reach the 90% end-to-end target; exact-turn
binding, evidence preservation, temporal/relational settlement, and reader
serialization must be measured independently.

A separate 19-error counterfactual localizes that downstream ceiling further.
The current packet answered 7/19, while both source-locked full context and an
answer-aware oracle turn projection answered 11/19. A prompt-only structured
synthesis arm fell to 5/19. This is post-hoc diagnostic evidence, not a held-out
score, but it rejects two tempting directions: global source expansion is not
needed for these cases, and adding more answer instructions is not a repair.
Exact-turn preservation inside an already selected source is the supported
hypothesis.

## 5. Next implementation order

1. Run the same frozen dev120 gate on v25: one semantic-support path, no
   unverified local-candidate rendering, and a typed requirement-to-evidence
   answer ledger. Do not advance if any high-confidence category regresses.
2. Gate the reason-coded verifier/planner split as v27 against v25. Its acceptance criteria
   are fewer closure fallbacks, no empty-input failures, no source-set widening,
   and no category regression. Then measure oracle retrieval, oracle packet,
   and oracle reader on remaining multi-session and temporal failures. Add a
   relation/state settlement stage only if oracle evidence proves the reader
   packet is the limiting gate.
3. Add document-level ingest recovery and publish both `product-parity` and
   `research-dense` profiles in every result.
4. Resume a sealed full500 only after dev gates pass. DeepSeek-judged results
   must remain labeled as non-official-judge results even when the official
   rubric semantics are used.
