#!/bin/bash
# ============================================================
# 微调前后对比评估：跑 core-tools 10 条核心用例
# 在 paw-ts 项目目录下运行
# ============================================================
set -e

CASES="core-tools-001,core-tools-004,core-tools-005,core-tools-006,core-tools-008,core-tools-012,core-tools-015,core-tools-016,core-tools-017,core-tools-020"

echo "=== 基线: Qwen3-14B 微调前 ==="
paw eval run --suite core-tools --model qwen --sandbox --repetitions 1

echo ""
echo "=== 切换到微调模型 ==="
# 修改 settings.local.json 中 qwen 的 model 路径
echo "提示: 手动修改 .paw/settings.local.json 中 qwen.model 为微调后的路径"
echo "     然后重跑: paw eval run --suite core-tools --model qwen --sandbox --repetitions 1"

echo ""
echo "=== 对比指标 ==="
echo "微调前 pass rate: (记录上面的结果)"
echo "微调后 pass rate: (重跑后记录)"
