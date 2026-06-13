# SWE-bench Lite Adapter for paw-ts

[SWE-bench](https://www.swebench.com/) is the standard benchmark for evaluating
LLM software engineering agents on real GitHub issues.

This directory contains an adapter that lets paw-ts run against the SWE-bench
Lite subset (300 issues) to measure bug-fixing capability.

## Prerequisites

```bash
pip install swebench datasets
```

You also need a GitHub token with public repo access (for cloning) and
API keys for whichever model paw-ts is configured to use (OpenAI, Anthropic,
etc.).

## Usage

### 1. Download the dataset

```bash
python -c "
from datasets import load_dataset
ds = load_dataset('princeton-nlp/SWE-bench_Lite', split='test')
ds.to_json('swe-bench-lite.jsonl')
print(f'Downloaded {len(ds)} instances')
"
```

### 2. Run the adapter

```bash
# Run on first 5 instances (cheap sanity check)
python benchmarks/swe-bench/run.py --input swe-bench-lite.jsonl --max-instances 5 --output results.jsonl

# Run on full Lite subset (expensive: ~$300-600 in API costs)
python benchmarks/swe-bench/run.py --input swe-bench-lite.jsonl --output results.jsonl
```

### 3. Evaluate with official harness

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path benchmarks/swe-bench/results.jsonl \
  --max_workers 4
```

## Expected Results

| Model / Agent | SWE-bench Lite |
|--------------|----------------|
| GPT-4 (zero-shot) | ~1.7% |
| Claude 3.5 Sonnet + scaffolding | ~15-20% |
| Claude 3.5 Sonnet + Agent | ~25-30% |
| Devin (reported) | ~13.9% |

paw-ts baseline target: **≥5%** (passes at least 15/300 issues).

## Cost Estimate

- Per instance: ~$0.50-2.00 (depends on model and issue complexity)
- Lite full (300): ~$150-600
- Verified subset (500, harder): ~$250-1000

Run a small subset first to validate the adapter before committing to the full
dataset.
