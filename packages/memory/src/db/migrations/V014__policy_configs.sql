-- V014: Policy Configs（可版本化的策略配置）

CREATE TABLE policy_configs (
  id              text PRIMARY KEY,
  domain          text NOT NULL,   -- write | retrieval | governance | context | retention | error
  name            text NOT NULL,   -- 策略名称，如 "default", "strict", "permissive"
  version         integer NOT NULL DEFAULT 1,
  scope_type      text NOT NULL DEFAULT 'global',  -- global | project | repository | user | task_type
  scope_value     text,            -- 作用域值（如 repository id）
  config          jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'active',  -- draft | active | deprecated
  description     text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_policy_key ON policy_configs (domain, name, scope_type, scope_value, version);
CREATE INDEX idx_policy_active ON policy_configs (domain, scope_type, scope_value, status);

-- 插入系统默认策略
INSERT INTO policy_configs (id, domain, name, version, scope_type, config, description) VALUES
('policy-default-write', 'write', 'default', 1, 'global',
 '{"allowedCandidateTypes":["task_summary","decision","failure","project_knowledge","user_preference","rule","skill"],"minConfidence":0.5,"requireEvidence":true,"maxCandidatesPerTask":20,"autoGenerationEnabled":true}',
 '默认写入策略'),
('policy-default-retrieval', 'retrieval', 'default', 1, 'global',
 '{"topK":10,"minScore":0.4,"allowedMemoryTypes":["task_summary","decision","failure","project_knowledge","user_preference","rule","skill"],"tokenBudget":4000,"retrievalMode":"memory_only"}',
 '默认检索策略'),
('policy-default-governance', 'governance', 'default', 1, 'global',
 '{"autoApproveLowRiskThreshold":0.6,"autoApproveMediumRiskThreshold":0.7,"autoApproveConditions":["low+sufficient_confidence","medium+high_confidence"],"autoRejectConditions":["no_evidence","schema_invalid"],"conflictMode":"reject","duplicateThreshold":0.9,"scopeConstraints":{}}',
 '默认治理策略'),
('policy-default-context', 'context', 'default', 1, 'global',
 '{"tokenBudget":{"totalTokens":8000,"reservedForSystem":200,"reservedForGeneration":2000,"availableForContext":5800,"categoryBudgets":{"hot":{"minTokens":500,"targetTokens":2000,"maxTokens":3000},"warm":{"minTokens":200,"targetTokens":1500,"maxTokens":2500},"cold_pointer":{"minTokens":0,"targetTokens":500,"maxTokens":1000}}},"evictionOrder":["pinned","importance","recent"]}',
 '默认上下文策略'),
('policy-default-error', 'error', 'default', 1, 'global',
 '{"maxRetries":3,"timeoutMs":10000,"codeIndexDegradation":"memory_only","memoryWriterFailure":"continue","policyFallbackOrder":["session_snapshot","last_known_good","safe_default","fail_closed"]}',
 '默认错误处理策略');
