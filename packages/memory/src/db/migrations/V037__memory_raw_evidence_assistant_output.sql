-- V037: retain complete conversational L0 evidence without treating assistant
-- text as user-grounded L1 memory.

ALTER TABLE memory_raw_evidence_spans
  DROP CONSTRAINT memory_raw_evidence_kind_valid;

ALTER TABLE memory_raw_evidence_spans
  ADD CONSTRAINT memory_raw_evidence_kind_valid CHECK (
    source_kind IN (
      'user_input', 'assistant_output', 'tool_observation', 'verification',
      'outcome', 'source_document'
    )
  );
