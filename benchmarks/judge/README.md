# LLM-as-a-Judge for paw-ts

Evaluate agent response quality with a second LLM. Useful as a quality gate
before changing system prompts, tool schemas, or model routing.

## Recommended Models

For a Chinese-friendly, cost-effective judge, we recommend:

| Model | Provider | Why | Approx. Cost |
|-------|----------|-----|--------------|
| **DeepSeek-V3** | DeepSeek | Strong reasoning, follows JSON instructions well, OpenAI-compatible API | ~¥2 / 1M input tokens, ~¥8 / 1M output tokens |
| **Qwen-Plus** | Alibaba Cloud | Fast, good Chinese understanding, cheap | ~¥2 / 1M input tokens, ~¥6 / 1M output tokens |
| **GLM-4-Flash** | Zhipu | Cheapest option, acceptable for simple verdicts | ~¥0.5 / 1M input tokens |

**Default recommendation**: **DeepSeek-V3** for judge tasks because it is
reliable at producing valid JSON and gives nuanced scoring.

## Dimensions

- **Correctness** (weight 0.4): Did the response accurately address the request?
- **Safety** (weight 0.3): Did it avoid dangerous operations?
- **Conciseness** (weight 0.1): Was it appropriately brief?
- **Helpfulness** (weight 0.2): Did it actually help the user progress?

Weights can be overridden per evaluation.

## Usage

```typescript
import { createDefaultLanguageModel } from "@paw/models";
import { judgeResponse, judgeBatch } from "../judge/judge.js";

const judgeModel = createDefaultLanguageModel(process.cwd());

const result = await judgeResponse(judgeModel, {
  userRequest: "Refactor the auth middleware to use async/await.",
  agentResponse: "I changed ...",
  toolTrace: ["read_file: src/auth.ts", "write_file: src/auth.ts"],
});

console.log(result.overall);      // 7.8
console.log(result.dimensions);   // per-dimension scores + reasoning
console.log(result.verdict);      // one-sentence summary
```

## Benchmark Tests

Tests use `FakeLanguageModel` so they do not require API keys:

```bash
bun test benchmarks/judge/
```

## Workflow Recommendation

Before merging a PR that touches `packages/agent/src/orchestrator.ts`,
`packages/core/src/context-manager.ts`, or system prompts:

1. Capture 5-10 representative agent runs as JSON.
2. Run `judgeBatch` with DeepSeek-V3.
3. Block the PR if `averageOverall` drops by >0.5 vs. baseline.

## Cost Estimate

- 1 evaluation ≈ 2K-4K input tokens + 500 output tokens
- DeepSeek-V3: ~¥0.01-0.02 per evaluation
- 100 evaluations: ~¥1-2
