# V27: durable desktop memory maintenance and legacy recall recovery

Date: 2026-09-08. Target: the desktop host and current Paw Next V3 runtime, using GLM-5.3-Flash high. Max experiments remain paused.

## Behavior

Normal desktop execution now publishes a small local ingress record at the terminal memory boundary and returns without waiting for extraction. The record contains the workspace, run identity, configuration hash and source sequence; it contains no credentials, task text or model messages. A database outage leaves that record available for a later host process.

One worker imports these records into PostgreSQL `desktop_memory_jobs` (migration V039). Jobs are bound to the machine, OS user and host checkout. Atomic claims use `FOR UPDATE SKIP LOCKED`, a random token and a 90-second lease. A stale worker cannot acknowledge a newer claim. A job permits three claims, including crash recovery; failures wait 30 then 60 seconds before the remaining attempts. Exhausted jobs remain `dead` for inspection. The worker polls every 30 seconds, starts only while foreground work is idle, and yields to a new foreground request by cancelling maintenance and waiting for the runtime's actual session cleanup.

The worker opens the existing journal under its fenced execution lease through `maintainExistingPawNextMemoryV3`. It does not enter Agent Loop or replay coding tools. The worker operation has a 40-second bound; extraction, conflict resolution, topic work and projection share the existing 30-second maintenance budget. Configured MCP catalogs are reconstructed from stored tool names without launching discovery subprocesses.

Failed extraction before staging can retry the same admitted evidence range. The retry limit is also enforced by durable journal claims, independently of process restarts or duplicate queue delivery. An uncertain database acknowledgement retains the staged ID for reconciliation. Successful topic organization is reused on background redelivery even if its own writes changed the catalog revision. Previous failure facts remain intact.

## Compatibility

Old desktop runs using the V2 workspace-based output-recall plugin can rebuild that precise registry identity. Recovery accepts it only when the complete reconstructed configuration hash matches the stored run. New tasks use V3 journal-authorized recall. Tests verify the original run identity, zero replayed model work, and rejection of configuration changes; this is not a general migration for arbitrary historical configurations.

## Live results

The previously verified V26 queue task had a failed HTTP 429 extraction and zero formal memory items. Maintenance reopened that same run, `desktop-next-2a1a2e28-a7a0-4e8d-b168-77384ab43d47`, using its original sandbox/profile and the real configured model.

| Check | Observed result |
| --- | --- |
| First bounded maintenance invocation | Completed in 22.043 seconds; 2 auxiliary model calls |
| Exact-ID PostgreSQL readback | 2 formal memory items present: one semantic and one episodic |
| First redelivery, before the topic fix | 1 extra auxiliary call in 9.755 seconds; exposed revision-driven reorganization |
| Redelivery after the fix | Completed in 1.173 seconds; 0 model calls; the same 2 memory items |
| Real ingress + PostgreSQL worker + V3 maintenance | Completed in 1.150 seconds; queue status `completed`, attempts 1, ingress empty, 0 model calls |

The extra pre-fix topic settlement and original failed extraction remain in the journal. The queue probe used an isolated host namespace and supplied the benchmark's original model/profile configuration; it did not claim unrelated production jobs. Its real PostgreSQL completion row is retained as evidence.

## Validation

- Main regression: **123 passed**, covering desktop continuation, long tasks, audit, memory, output recall, profile compatibility and permission boundaries.
- Final memory-maintenance suite after the redelivery fix: **34 passed**, including the new catalog-revision regression. The desktop audited-memory suite also passed its 10 cases after that change.
- Final worker suite: **3 passed**, including foreground preemption and waiting for lease cleanup.
- Actual PostgreSQL tests verify machine isolation, concurrent claims, expired leases, stale acknowledgements, backoff, crash limits and completed-job deduplication.
- CLI, desktop renderer/host and memory-plugin typechecks passed; `git diff --check` passed.
- Native Electron QA passed with the real preload/Bun host at 960×640, 1100×800 and 1440×960. Its background memory worker was explicitly disabled to keep UI checks from processing real jobs.

Ignored evidence is under `.runs/2026-09-08-v27-*`, including regression/typecheck logs, live memory and queue results, and native screenshots. PostgreSQL tests explicitly set the local test URL because Bun test mode did not load the root `.env.local`; the actual `bun run` host/probe did load it.

## Limits and next work

This verifies durable delivery and bounded recovery, not a guaranteed provider success rate or the long-term usefulness of generated memories. Terminal topic-organization failures are reported as blocked rather than silently successful; automatic retry of already-settled failed topic organization and failed derived dossiers is outside this change. Old tasks whose full profiles cannot be reconstructed still fail closed.

The local PostgreSQL database remains `paw_memory` on loopback port 54329; cloud PostgreSQL and Langfuse are not connected. Model-injected test/probe calls retain synchronous maintenance unless they explicitly opt into background delivery. There is not yet a desktop UI for inspecting or manually retrying dead jobs.

Next: measure and reduce repeated context and auxiliary requests on high, then run fresh small, medium and long coding tasks. V26's 680.708-second coding time is historical and is not a before/after performance result for V27.
