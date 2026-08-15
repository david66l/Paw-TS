-- V033: commercial isolation boundary for long-term memory v2.
-- Legacy rows are quarantined under a non-runtime scope instead of being
-- guessed into a user/tenant, which would risk cross-account disclosure.

UPDATE memory_items
SET scope = jsonb_build_object(
  'tenantId', 'legacy',
  'userId', 'legacy',
  'workspaceId', COALESCE(scope->>'workspaceId', scope->>'repositoryId', 'legacy'),
  'repositoryId', COALESCE(scope->>'repositoryId', 'legacy')
) || scope
WHERE NOT (
  scope ? 'tenantId' AND scope ? 'userId'
  AND scope ? 'workspaceId' AND scope ? 'repositoryId'
);

CREATE INDEX IF NOT EXISTS idx_memory_items_scope_key_active
  ON memory_items (
    (scope->>'tenantId'), (scope->>'userId'),
    (scope->>'workspaceId'), (scope->>'repositoryId'), updated_at DESC
  ) WHERE t_invalid IS NULL;

ALTER TABLE memory_items DROP CONSTRAINT IF EXISTS memory_items_scope_key_complete;
ALTER TABLE memory_items ADD CONSTRAINT memory_items_scope_key_complete CHECK (
  (
    scope ?& ARRAY['tenantId', 'userId', 'workspaceId', 'repositoryId']
    AND length(scope->>'tenantId') > 0
    AND length(scope->>'userId') > 0
    AND length(scope->>'workspaceId') > 0
    AND length(scope->>'repositoryId') > 0
  ) OR (
    -- Compatibility/admin rows are quarantined: scoped runtimes require all
    -- four fields in every SQL predicate and therefore never see these.
    NOT (scope ? 'tenantId') AND scope ? 'repositoryId'
  )
);

ALTER TABLE memory_trial_lessons ADD COLUMN IF NOT EXISTS scope jsonb;
ALTER TABLE memory_trial_lessons ALTER COLUMN scope SET DEFAULT
  jsonb_build_object('tenantId', 'legacy', 'userId', 'legacy', 'workspaceId', 'legacy', 'repositoryId', 'legacy');
UPDATE memory_trial_lessons
SET scope = jsonb_build_object(
  'tenantId', 'legacy', 'userId', 'legacy',
  'workspaceId', 'legacy', 'repositoryId', 'legacy'
)
WHERE scope IS NULL;
ALTER TABLE memory_trial_lessons ALTER COLUMN scope SET NOT NULL;
ALTER TABLE memory_trial_lessons DROP CONSTRAINT IF EXISTS trial_lessons_scope_key_complete;
ALTER TABLE memory_trial_lessons ADD CONSTRAINT trial_lessons_scope_key_complete CHECK (
  scope ?& ARRAY['tenantId', 'userId', 'workspaceId', 'repositoryId']
);

CREATE INDEX IF NOT EXISTS idx_trial_lessons_scope_key
  ON memory_trial_lessons (
    (scope->>'tenantId'), (scope->>'userId'),
    (scope->>'workspaceId'), (scope->>'repositoryId'), created DESC
  );

ALTER TABLE memory_lifecycle_review ADD COLUMN IF NOT EXISTS scope jsonb;
ALTER TABLE memory_lifecycle_review ALTER COLUMN scope SET DEFAULT
  jsonb_build_object('tenantId', 'legacy', 'userId', 'legacy', 'workspaceId', 'legacy', 'repositoryId', 'legacy');
UPDATE memory_lifecycle_review AS review
SET scope = item.scope
FROM memory_items AS item
WHERE review.entry_id = item.id AND review.scope IS NULL;
UPDATE memory_lifecycle_review
SET scope = jsonb_build_object(
  'tenantId', 'legacy', 'userId', 'legacy',
  'workspaceId', 'legacy', 'repositoryId', 'legacy'
)
WHERE scope IS NULL;
ALTER TABLE memory_lifecycle_review ALTER COLUMN scope SET NOT NULL;
ALTER TABLE memory_lifecycle_review DROP CONSTRAINT IF EXISTS lifecycle_review_scope_key_complete;
ALTER TABLE memory_lifecycle_review ADD CONSTRAINT lifecycle_review_scope_key_complete CHECK (
  scope ?& ARRAY['tenantId', 'userId', 'workspaceId', 'repositoryId']
);
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_review_scope_key
  ON memory_lifecycle_review (
    (scope->>'tenantId'), (scope->>'userId'),
    (scope->>'workspaceId'), (scope->>'repositoryId'), created_at DESC
  );
