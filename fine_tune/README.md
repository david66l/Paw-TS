# Qwen3-14B Fine-tuning for paw-ts

## 文件

| 文件 | 作用 |
|------|------|
| `dataset_info.json` | LLaMA-Factory 数据集注册 |
| `lora_config.yaml` | LoRA 训练配置 |
| `run_validation.sh` | 验证轮 (30条, 1 epoch, ~10 min) |
| `eval_comparison.sh` | 微调前后对比评估 |

## 验证流程

### 1. 准备数据

```bash
# 已在 training_data/ 下
stage_e_validation_30.jsonl   # 30条验证数据 (10种工具)
```

### 2. 在 autodl 服务器上运行

```bash
cd paw-ts/fine_tune
bash run_validation.sh
```

### 3. 重启 vLLM 加载微调模型

```bash
vllm serve ./qwen3-paw-lora-validation-merged \
  --enable-auto-tool-choice \
  --port 8000
```

### 4. 评估对比

```bash
# 修改 .paw/settings.local.json 中 qwen.model 指向微调模型
paw eval run --suite core-tools --model qwen --sandbox --repetitions 1
```

### 5. 判断标准

| 结果 | 含义 | 后续 |
|------|------|------|
| 通过率 > 70% | 格式兼容，方向正确 | 跑全量微调 |
| 通过率 40-70% | 有提升但不稳定 | 加数据继续 |
| 通过率 < 40% | 格式冲突 | 检查训练数据格式 |

## 全量微调 (验证通过后)

```bash
# 修改 lora_config.yaml:
#   dataset: paw_full
#   lora_rank: 64
#   num_train_epochs: 2
#   output_dir: ./qwen3-paw-lora-full

llamafactory-cli train lora_config.yaml
```
