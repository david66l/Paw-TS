# V12: bounded memory maintenance and ambiguous-write recovery

Date: 2026-09-08. Target: desktop composition on the journal-backed V3 runtime.

The terminal memory path is now bounded by one 30-second operation deadline. An ambiguous database or journal acknowledgement leaves a staged write recoverable instead of recording a false failure. This is a correctness prerequisite for moving the pipeline to a durable background worker; **V12 does not implement that worker or an outbox**.

## Findings and design basis

`apps/cli/src/paw-next/composition.ts` previously awaited raw evidence archival, extraction, reconciliation, atom storage, topic organization, catalog loading and dossier projection before returning the terminal task result. Optional failures were caught, but unresolved promises could keep the task session and execution lease open indefinitely.

`packages/memory-plugin/src/memory-writer.ts` and `topic-organizer.ts` caught store errors and wrote terminal failed/interrupted settlements with empty result IDs. A store may already have committed before its response is lost; a journal commit may also have succeeded before its acknowledgement fails. Recording a permanent failure in those cases prevents the existing staged recovery path from reconciling the real result. In particular, the atom store already supported replaying a partial replacement/invalidation/temporal-relation write, but the controller could prematurely close it.

The legacy `packages/memory/src/longterm/write/pipeline.ts` and `runtime/memory-runtime-v2.ts` use PostgreSQL outbox events and a serial worker. That is the reference for the planned scheduling migration. Reusing it wholesale would discard the new runtime's source admission and claim/stage/settle protocol. Starting the current controller with an unawaited promise would instead reuse a session that `withFencedPawNextSessionV1` closes when the task returns.

Durable handoff and idempotent consumption follow the considerations in [AWS's transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html). The implementation here reuses Paw's existing operation-deadline primitive, durable staged facts and store identifiers. It does not introduce a database, cloud service, polling worker or dependency.

## Implemented behavior

| Boundary | V12 behavior |
| --- | --- |
| Terminal work | A single 30-second budget begins when `settleTerminal` is invoked, not when the coding task starts. It is shared across all memory stages and topics. |
| Async dependencies | `memory-maintenance.ts` gates journal reads/CAS, archive writes, recall, extraction, reconciliation, atom apply, topic prepare/extract/apply, catalog reads and dossier reads/extracts/writes with the same operation. |
| Cancellation and late results | Parent cancellation interrupts host waiting. A result arriving after cancellation/deadline cannot initiate another gated stage or journal write. Adapter-normalized abort errors retain the operation's actual timeout/cancellation cause. |
| Staging acknowledgement lost | Do not append an unstaged failure. On recovery, inspect the durable journal to determine whether the candidate exists. |
| Apply acknowledgement lost | Keep the claim and staged payload unsettled. Recovery reuses their IDs and proposals; it does not ask the model to extract them again. |
| No candidate staged | An interrupted claim is closed as interrupted on the next recovery. No hidden model retry is introduced. |
| Evidence admission | Existing source admission is rechecked before applying recovered or newly staged atoms. Invalidated evidence still produces a rejection. |
| Atom storage | Recheck cancellation after awaited reads/puts/invalidations so a late read cannot initiate a replacement or invalidation. An already-started mutation may still commit. |
| Desktop diagnostics | Forward content-free `memory.maintenance` events, including timeout and recovery-pending reasons, through the desktop event stream. No source statements or error-message bodies are included. |
| Optional failure | The authoritative coding-task terminal decision is preserved. Recovery does not rerun the coding task. |

The composition delegates this orchestration to `createMemoryMaintenanceControllerV1` in the memory plugin. Its archive watermark is retained across settlements on the same controller, so successful archive writes are not repeated for every segment. The V3 fresh/existing paths use the same controller and retain the existing audit admission seam.

The 30-second value is a conservative upper bound for optional foreground maintenance, **not a measured optimal extraction budget**. It does not alter main-model output limits, thinking effort, request supervision or the default-disabled reasoning-recovery experiment.

## Identity

- Composition: `paw.product-composition.v3.26:bounded-memory-maintenance`
- Manifest memory policy: `paw.memory-maintenance.v1:shared-30s-deadline:staged-recovery`
- Basic V3 golden hash: `37c5cc5fe7ddc74217a48ee545bad81330eac06efc1d85978feee4d4f61751f1`

The changed policy participates in exact manifest identity. V1/V2 identity golden values remain unchanged; this does not imply that older V3 manifests can be resumed under a different composition version.

## Validation

The memory regression command passes **85 tests, 0 failures, 377 assertions** across five files:

```powershell
bun test packages/memory-plugin/test/memory-maintenance.test.ts packages/memory-plugin/test/temporal-graph.test.ts packages/memory-plugin/test/topic-organizer.test.ts packages/memory-plugin/test/memory-plugin.test.ts packages/memory-plugin/test/topic-dossier.test.ts --timeout 30000
```

The new maintenance tests inject unresolved/late promises at 18 boundaries, exercise cancellation during extraction and conflict reconciliation, and simulate six lost-acknowledgement boundaries. They validate the resulting journal with the protocol parser and reconstruct controllers/snapshots for recovery. Timeouts are scaled down for deterministic fault tests; these are not latency benchmarks.

`apps/desktop/test/auditedMemory.test.ts` additionally exercises the **real V3 file-session lifecycle**: a simulated database acknowledgement failure leaves a staged write, the coding task completes, and a new `runExistingPawNextTaskV3` invocation settles the same ID without another coding or extraction call. This uses injected stores, not a live PostgreSQL failure.

The three selected composition memory tests pass with 33 assertions, including off mode, scope-bound search and terminal two-phase writing. Workspace dependencies remain acyclic: 25 packages, 103 edges.

The desktop/V3 regression command passes **59 tests, 0 failures, 553 assertions** across four files (107.32 seconds):

```powershell
bun test apps/cli/test/paw-next-product-v3.test.ts apps/desktop/test/auditedMemory.test.ts apps/desktop/test/pawNext.test.ts apps/desktop/test/runtimeHardening.test.ts --timeout 30000
bun test apps/cli/test/paw-next-composition-v2.test.ts --test-name-pattern 'root memory plugin|scope-bound memory search|opt-in memory writer' --timeout 30000
```

Together the final regression commands cover **147 distinct tests, 0 failures, 963 assertions**, including 37 newly added cases. Memory-plugin, CLI, desktop host and desktop frontend TypeScript checks pass; `git diff --check` passes. An initial fault-test assertion exposed cancellation normalization and was corrected by preserving the operation's cause. The cancellation test harness was also corrected to attach ordinary promise rejection handlers before triggering cancellation, avoiding Bun's eager async matcher waiting before the cancellation action.

## Limits and next step

- Foreground memory work can still take up to the operation budget. It has not been moved off the terminal path.
- No background queue, automatic restart consumer or eventual-delivery guarantee is provided. Pending staged work is reconciled when the same run is explicitly resumed through the existing runtime path.
- An unresolved external write can still commit remotely; deadlines cannot roll it back or guarantee that remote billing stops. Recovery relies on existing store idempotency. Synchronous JavaScript and a stuck underlying filesystem close are outside the promise deadline's cancellation guarantees.
- Claims interrupted before staging are not automatically re-extracted. Historical failures already marked terminal by older code are not automatically reopened.
- A persisted outbox must bind the admitted source boundary and exact model/scope configuration, acquire independent durable ownership, preserve staged facts across crashes, and use bounded consumption. A separate enqueue file is not by itself atomic with the task journal; crash-gap reconciliation must be designed before claiming lossless handoff.
- No live GLM/DeepSeek benchmark, live PostgreSQL outage test, native-window inspection, commit or push was performed in this round. This establishes bounded waiting and recovery behavior, not improved long-task completion rates.
