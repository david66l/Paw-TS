# V13 desktop host performance investigation

2026-09-08. This is an offline performance investigation using the successful V12 queue/high recording. It is **not** a new live-model success-rate, reasoning or cost result.

## Reproduction and findings

`session-replay-profile.ts` validates a settled committed prefix, then replays its 133 original commit batches through a new fenced file session. It does not execute recorded tools or model calls and does not mutate the source workspace. It records selected synchronous filesystem calls and per-batch timings.

The first session replay took 8.844 seconds, with 44,688 `readFileSync` calls and 97,223 `lstatSync` calls. A second replay after merging redundant authority checks took 8.869 seconds, with 35,777 reads and 42,693 status checks. The operation counts fell by 19.9% and 56.1%; these two wall-time samples do **not** demonstrate a speedup. They also do not account for all of the live run's 71.076-second residual host time.

`desktop-replay-profile.ts` then feeds the original 23 recorded HTTP response bodies through the real `runDesktopNext` entry. All model fetches are intercepted locally; there is no network fallback. The original tool decisions execute in the same pinned, network-isolated Docker image and a new temporary workspace. Main/auxiliary model parameters and tool schemas must match the corresponding recording. Current prompts may differ, and immediate response delivery differs from live streaming. Outputs are explicitly marked `offline_recorded_model_replay` in `replay.json` and `protocol.json`.

The first full desktop replay, with authority deduplication but without token caching, took 143.525 seconds for 23 recorded requests. Its sampled profile identified:

- `TiktokenEstimator` / `encode`: approximately 38.93 seconds inclusive; repeated full-context selection, final accounting and category accounting encode the same strings repeatedly.
- `buildVerifiedCanonicalPayloadIndexV1` / file payload resolution: approximately 34.96 seconds inclusive; repeated directory/path checks while resolving historical payloads.
- Execution-lease validation remains another growing cost.

These are inclusive sampled call-tree measurements, can overlap, and must not be added together or equated directly with the earlier live run's residual. Docker, instrumentation, OS caching and lack of live model waits differ between runs.

## Implemented changes

1. `readAuthority` enumerates the namespace once and validates each formal event immediately before reading it. Strict inventory readers use this same validation with repair disabled. Historical bytes, hash chains, hardlinks, symlinks and fencing remain checked on every authority read; no filesystem trust cache was introduced.
2. `FileRunSessionV1.commitRecords` no longer repeats its caller's authority read before any asynchronous yield. Serialized callers still check authority, and checks remain after artifact publication/hooks and at the journal-head CAS.
3. `TiktokenEstimator` caches raw counts by exact text within each estimator. The LRU retains at most 2,048 entries and 1,048,576 UTF-16 code units of key text; this bounds logical text retention, not total engine heap size. Oversized texts bypass the cache. Exceptions are not cached. Different encodings use different instances; calibration remains outside the cache. Mutable message objects are never used as cache keys.

The existing tokenizer, large-text chunking, per-message overhead, attachments, tool fields, calibration and context thresholds are unchanged. No model output limit, reasoning deadline, automatic recovery or completion criterion was relaxed. This preserves the existing composition identity because the request/counting semantics are unchanged.

## Legacy comparison

The old runtime's `FileSystemSessionStore.saveEvent` directly appends JSONL, but does not implement the new authority hash chain and journal-head fencing. Replacing the new journal with that store would lose guarantees. Its token estimator is the same shared core implementation: it already reuses the WASM encoding instance, but did not cache text counts. The bounded count cache therefore benefits both runtimes without moving legacy orchestration into V3.

## Validation

Both full replays include authority deduplication; the difference between these two conditions is token-count caching. Both used the CPU profiler and the original 23 response bodies, verified by SHA-256. Every declared deliverable (`src/*.js`, `test/queue.test.js`, `package.json`, README and REQUIREMENTS) is byte-identical across the two new workspaces. Independent Docker grading passes 15/15 in both; each workspace's own 24-test suite also passes.

| Measurement | Without count cache | With count cache |
| --- | ---: | ---: |
| Desktop start to terminal | 143.524 s | 106.485 s |
| Tool activity union | 62.674 s | 62.707 s |
| Recorded-response handling | 0.515 s | 0.511 s |
| Other host residual | 80.335 s | 43.267 s |
| Sampled `tiktoken.encode` inclusive time | 38.93 s | 0.147 s |
| Completed and independently verified | yes | yes |

Observed elapsed time fell 25.81% in this ordered pair. It is one replay per condition; do not interpret that percentage as a live-model latency guarantee. Recorded usage numbers are replay data, not API usage incurred by this experiment. No paid model requests were made.

Regression checks: **218 passed, 2 skipped, 0 failed**, 1,120 assertions across 14 files. This includes estimator equivalence for both encodings and large strings, bounded LRU eviction, failure retry, message mutation/calibration, context selection, desktop continuation/approval/recovery, publication expiry, historical tampering, cross-process fencing, snapshots and strict readers. Two existing file-symlink cases are explicitly skipped on Windows by their test definitions; hardlink, junction and ancestor-swap coverage passes. Runtime/core TypeScript and targeted Biome checks pass.

Local evidence (ignored `.runs/`): `session-profile-before.json`, `session-profile-after.json`, `2026-09-08-v13-desktop-replay/`, `2026-09-08-v13-desktop-replay-cached/`, and `v13-replay-comparison.json`. CPU profiles accompany those runs. The cached replay additionally freezes the profiled core/session/payload sources; a subsequently removed unused helper and formatting do not change the executed path.

Reproduce with the configured GLM preset (the replay intercepts the HTTP calls):

```powershell
bun run --cpu-prof --cpu-prof-md --cpu-prof-dir=benchmarks/desktop-harness-ab/.runs benchmarks/desktop-harness-ab/desktop-replay-profile.ts <recorded-queue-high-dir> <fresh-replay-dir>
python benchmarks/desktop-harness-ab/single-agent-report.py <settled-replay-dir>
python benchmarks/desktop-harness-ab/desktop-replay-report.py <before-dir> <after-dir> <comparison.json>
```

Use `session-replay-profile.ts <source-workspace> <session-id> <run-id> <output.json>` for the narrower journal-only experiment, which needs neither a model nor Docker. Do not use the general live-validation report to label offline replays as live-model results.

## Remaining work

The verified payload reader still repeatedly walks directories for historical payloads. Any optimization there needs to preserve detection of ancestor swaps, hardlinks, corrupted payload bytes and stale evidence. This change does not claim to solve GLM max's reasoning-only stall or reduce paid model token usage. The original 15/15 live high result and failed max result remain the latest live-model evidence.
