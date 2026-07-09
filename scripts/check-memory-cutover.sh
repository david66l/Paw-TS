#!/usr/bin/env bash
# 门禁：在线路径禁止旧 file 记忆机制回潮。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0

if [[ ! -f packages/memory/src/runtime/memory-runtime.ts ]]; then
  echo "FAIL: MemoryRuntime missing"
  fail=1
fi

if ! rg -q 'createMemoryRuntime' packages/agent/src/orchestrator.ts; then
  echo "FAIL: orchestrator must use createMemoryRuntime"
  fail=1
fi

# 已删除的旧在线模块不得复活
for f in \
  packages/agent/src/resolve-memory-provider.ts \
  packages/agent/src/memory-extraction-agent.ts \
  packages/agent/src/resolve-memory-retrieval.ts \
  packages/agent/src/llm-memory-selector.ts \
  packages/agent/src/context-builder.ts \
  packages/agent/src/orchestrator/memory-extraction.ts \
  packages/agent/src/orchestrator/session-summarizer.ts \
  packages/agent/src/orchestrator/background-review.ts \
  packages/memory/src/file-provider.ts \
  packages/memory/src/memory-retrieve.ts \
  packages/memory/src/memory-retriever.ts \
  packages/memory/src/unified-memory-store.ts
do
  if [[ -f "$f" ]]; then
    echo "FAIL: deleted legacy file reappeared: $f"
    fail=1
  fi
done

if rg -n 'FileProvider|retrieveRoutedMemories|UnifiedMemoryStore|createMemoryWriter|KeywordMemoryRetriever' \
  packages/agent/src packages/harness/src --glob '*.ts' 2>/dev/null; then
  echo "FAIL: agent/harness still references deleted legacy online memory APIs"
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "check-memory-cutover: ok"
  exit 0
fi
exit 1
