# Benchmarks

## Frozen V15 validation baseline

| Dataset | Questions | Correct | Accuracy |
| --- | ---: | ---: | ---: |
| LongMemEval-S independent validation subset | 120 | 101 | 84.17% |

This result is bound to the frozen V15 behavior baseline. It is an internal
validation result, not an official leaderboard submission and not a claim over
an untouched public test server.

Refactors in this package are required to preserve the deterministic unit and
integration gates before the benchmark is rerun. Benchmark prompts, private
records, caches, credentials, and sealed run plans are intentionally excluded
from this source package.

