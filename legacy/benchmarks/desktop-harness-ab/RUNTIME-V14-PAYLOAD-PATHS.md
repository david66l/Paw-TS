# V14 historical payload path checks

2026-09-08. Follow-up to the [V13 host profile](RUNTIME-V13-HOST-PERFORMANCE.md). This investigation uses recorded model responses and the real desktop host with Docker tools; it makes no new live-model quality or paid-token claim.

## Problem and change

The V13 cached replay still spent approximately 35.72 sampled inclusive seconds in `buildVerifiedCanonicalPayloadIndexV1`, largely resolving historical payload files. `readAndVerifyArtifact` checked the directory chain, then immediately called `readStableArtifactFile`, which checked the same chain again. A third check followed byte and binding verification. Each pass also rebuilt the fixed directory names and computed relative paths for already-canonical paths.

The file payload store now:

- Builds and freezes its five lexical directory paths once per reader/writer identity. It does not cache filesystem metadata, content, verification results or trust decisions.
- Checks the live directory chain in `readStableArtifactFile` before opening, then again after content verification. The redundant outer pre-read pass is removed.
- Uses exact equality between the freshly resolved canonical path and its already-contained lexical path to prove containment in the common case. Different strings still use the original `path.relative` containment check, including the same-prefix-sibling and parent-escape checks.
- Uses the same precomputed path list for directory creation, validating each created prefix before proceeding.

For a normal successful resolve, directory `lstatSync` and `realpathSync.native` calls fall from 15 each to 10 each. Artifact file checks still compare descriptor/path identity, size, link count and timestamps around the read. Content hashes, canonical encoding, semantic binding, policy limits, abort handling and the post-read directory check remain in place. Artifact references, disk layout and composition identity are unchanged.

## Legacy reference

The shared workspace path guard used by the old runtime also resolves real paths before checking containment. It permits some paths that the immutable payload store must reject, including links that remain within the workspace. Its general workspace-access policy is therefore not substituted for payload authority checks. This change reuses fixed path computation while preserving the payload store's stricter checks.

## Added regression coverage

- Count both live directory-check passes and then alter the already-read artifact: the next read must reject the new bytes.
- Replace the store directory after the artifact descriptor closes with a symlink/junction to the same unchanged bytes: the post-read check must reject the redirected directory.
- Return a canonical path in a sibling whose name merely starts with the workspace name: the containment fallback must reject it.

Final regression run: **139 passed, 1 skipped, 0 failed**, 901 assertions across 7 files. Coverage includes payload policy/store/index, location-aware session materialization, context budgeting, desktop continuation/attachments/approval/recovery and runtime hardening. The existing artifact-file-symlink case is explicitly skipped on Windows. Runtime TypeScript, targeted Biome and diff-whitespace checks pass.

## Scope

Recorded-response replay removes model network waits and does not measure whether a model chooses better actions. This optimization does not reduce model-visible context, change tokenizer estimates, lower reasoning/output limits, enable retries or alter completion criteria. Historical payloads are still read and verified; remaining costs require their own profiles and correctness checks.

## Replay results

The same 23 original response bodies replay through `runDesktopNext` with the same pinned Docker image. Model HTTP calls are served locally. Independent Docker grading passes **15/15**, and the generated project's own **24 tests** pass. All declared source, test, package, README and requirements files are byte-identical to the V13 cached replay.

| Measurement | V13 token cache | V14 path optimization |
| --- | ---: | ---: |
| Desktop start to terminal | 106.485 s | 95.349 s |
| Tool activity union | 62.707 s | 58.830 s |
| Recorded-response handling | 0.511 s | 0.550 s |
| Other host residual | 43.267 s | 35.969 s |
| Sampled payload-index construction, inclusive | 35.72 s | 20.77 s |

Observed elapsed time falls **10.46%** versus the previous cached replay. Compared with V13's initial 143.524-second replay before token caching, it falls about **33.57%**. These are individual ordered observations with the CPU profiler enabled, not a live-model speed guarantee. Tool activity also varies between samples; the full elapsed difference must not be attributed entirely to path checks. The residual is subtraction-based wall time, and sampled inclusive call-tree times can overlap.

Evidence is retained under ignored `.runs/2026-09-08-v14-desktop-replay-paths/`, `.runs/v14-replay-comparison.json`, and `.runs/CPU.50745105280.46680.md`. The replay freezes relevant production sources and verifies recorded response hashes; the comparison checks completed status, independent grading, matching image/task, and identical deliverable hashes.

Reproduce using `desktop-replay-profile.ts`, `single-agent-report.py` and `desktop-replay-report.py` as described in the V13 report. No paid model requests were made for this experiment.
