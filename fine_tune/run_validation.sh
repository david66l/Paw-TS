#!/bin/bash
# ============================================================
# 微调验证脚本 (30条, 1 epoch, ~10 min)
# 在 autodl 服务器上运行
# ============================================================
set -e

echo "=== Step 1: 安装 LLaMA-Factory ==="
pip install llamafactory -q

echo "=== Step 2: 训练 ==="
llamafactory-cli train lora_config.yaml

echo "=== Step 3: 导出 LoRA 权重 ==="
llamafactory-cli export \
  --model_name_or_path /root/autodl-tmp/qwen3-14b-awq \
  --adapter_name_or_path ./qwen3-paw-lora-validation \
  --template qwen \
  --finetuning_type lora \
  --export_dir ./qwen3-paw-lora-validation-merged \
  --export_size 2 \
  --export_legacy_format false

echo ""
echo "=== 完成 ==="
echo "导出路径: ./qwen3-paw-lora-validation-merged"
echo "在 vLLM 中加载: --model ./qwen3-paw-lora-validation-merged"
