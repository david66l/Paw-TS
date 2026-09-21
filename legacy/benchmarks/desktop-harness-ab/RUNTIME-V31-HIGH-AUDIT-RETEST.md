# V31: live high retest after audit recovery changes

Date: 2026-09-09. Actual desktop host and Paw Next V3, GLM-5.3-Flash high.

## Protocol

Baseline: `.runs/2026-09-08-v29-queue-high`. Fresh run: `.runs/2026-09-09-v31-queue-high`.

The same persistent queue + CLI + tests + README task uses the same 840-second overall wall budget, 53 physical calls, 32 root steps, native 128,000-token output limit, disabled cumulative reported-token cutoff, Docker image/sandbox and tool catalog. Memory retrieval uses the existing local PostgreSQL; terminal extraction is queued under isolated background ingress. No implementation delegation is enabled; independent audit children remain enabled. Only one Paw model experiment runs at a time.

The new desktop record confirms `environmentAuditRetry: true`. This run includes the V29 bounded-summary fix and V30 audit-only retry policy. Per-audit limits remain 120 seconds / 12 model turns, with one retry for `AuditTimeout` against the same candidate. The whole task remains bounded by the original wall/call allowance; it does not receive extra wall time for the retry.

```powershell
bun --env-file=.env.local benchmarks/desktop-harness-ab/tool-wire-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-09-v31-queue-high --queue --docker --configured-profile --memory --background-memory --environment-audit --single-agent --wall-and-call-budget --desktop-chain-budget
```

The baseline and new run have identical task, model profile, capabilities and budget fields. `compare-high-runs.py` additionally checks the actual root wire parameters and tool catalog for every request after both runs settle. Different workspace paths, generated implementations, memory contents, provider load/cache and scheduling prevent a single sample from establishing a causal speedup or a success rate.

`audit-chain-report.ts` reads only an authority-committed, settled root journal through the runtime's strict reader. It reports durable review IDs, candidate identity, outcomes, timing and root work after the first review; it does not run a model, acquire an execution lease or execute generated code. Its baseline output reconciles V29's 120.349-second timeout, 63.960-second invalid report, two repair inputs and two extra work segments. Raw prompts and credentials are not printed.

## Results

The fresh run reaches `completed / verified` in **751.449 seconds**, passes **15/15 independent functional checks**, and passes **29/29 generated project tests**. Independent grading executes in the Docker sandbox. The generic `verification.json` still contains the unrelated `probe.txt` sentinel fields; queue correctness is graded in `single-agent-report.json`.

| Measure | V28 successful baseline | V29 previous run | V31 current run |
| --- | ---: | ---: | ---: |
| Runtime outcome | completed / verified | aborted at wall limit | completed / verified |
| Seconds | 817.431 | 840.157 | 751.449 |
| Physical requests | 40 | 34 | 26 |
| Reported tokens | 800,863 | 682,559 | 700,936 |
| Requests without usage | 3 | 5 | 1 |
| Independent checks | 15/15 | 15/15 | 15/15 |
| Generated project tests | 31/31 | 31/31 | 29/29 |
| Audit attempts | 3 | 2 | 1 |

Generated test counts differ because each run creates a fresh implementation. The independent acceptance checks are the same. Comparisons against both baselines match task, budgets, profiles, sandbox, actual root wire parameters and tool catalog. Source changes are retained in the comparison artifacts.

The current audit inspects nine files and passes on its first attempt in **55.710 seconds**. The authority-committed root journal records **zero root model settlements, zero root tool calls, zero repair inputs and zero new work segments after the first audit starts**. V29 instead had a timeout followed by an invalid report, four additional root calls, two repair inputs and two work segments.

The V30 retry policy is enabled in the fresh desktop identity, but **this sample does not trigger timeout recovery**. It validates normal live closeout with the new policy present; retry exhaustion, cancellation, stale-candidate rejection and crash recovery remain supported by the V30 fault tests, not by this live sample.

## Usage and remaining bottleneck

| Phase | Requests | Reported tokens |
| --- | ---: | ---: |
| Root implementation loop | 22 | 662,864 |
| Independent audit child | 3 | 38,072 |
| Startup memory query | 1 | Unknown |
| Total | 26 | 700,936 |

Known usage consists of 677,364 input tokens and 23,572 completion tokens. Input includes 378,112 cache-hit tokens and 299,252 cache-miss tokens. The root loop accounts for approximately 94.6% of reported usage. These are cumulative provider counters across requests, not the size of one context window.

V31 uses fewer requests and fewer reported tokens than successful V28, but more reported tokens than aborted V29. Its known cache-miss input plus output is **322,824**, versus 291,103 in V28 and 278,655 in V29. Missing usage, different implementations and cache behavior prevent a monetary-saving claim. V28 also overlapped another Paw experiment, unlike this run; one sample does not establish a general speedup or reliability improvement.

The implementation stage still includes test-command discovery and repairs: `node --test test/` fails under the sandbox's Node version, and some generated shell pipelines initially mask failing tests with a successful wrapper exit. Subsequent direct tests expose the failures; the model repairs them and the final direct test and external checks pass. Thus this run supports successful recovery and completion, not immediate correctness or elimination of long thinking. The first successful file tool arrives at 243.520 seconds.

The next useful optimization is a measured review of root request context: repeated reasoning, old write arguments and superseded test output. Preserve current work state and retrievable evidence, then compare a bounded context change using the same independent checks. The audit path is no longer the dominant usage source in this sample.

## Evidence and cleanup

Run ID: `desktop-next-36a23b89-ed69-47bd-9a46-a06cd69fdbaf`.

The run directory retains `result.json`, `single-agent-report.json`, `phase-cost-report.json`, `audit-chain-report.json`, `high-run-comparison.json` (V29 comparison), `high-run-comparison-v28.json`, raw captures and frozen source manifests. The report helper also reconciles the historical V29 journal without changing its outcome or raw captures.

Local PostgreSQL retrieval and isolated background ingress were enabled. The background queue was not drained in this experiment, so this result does not newly verify durable extracted memory writes. The PostgreSQL container started for this run has been stopped again; no Paw container or Bun process remains running after verification. Unrelated Docker services were left untouched.

This step adds the read-only audit-chain reporter and experiment documentation; it makes no production runtime changes.
