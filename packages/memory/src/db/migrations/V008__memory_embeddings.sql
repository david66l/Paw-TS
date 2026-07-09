-- V008: Memory Embeddings（pgvector 向量索引）

CREATE TABLE memory_embeddings (
  id                  text PRIMARY KEY,
  memory_id           text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  memory_version_id   text NOT NULL,
  embedding           vector(1536),
  embedding_model     text DEFAULT 'text-embedding-3-small',
  embedding_version   text DEFAULT '1.0',
  index_revision      integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_embeddings_memory ON memory_embeddings (memory_id);

-- vectors 索引（IVFFlat，适合 MVP 规模）
-- 数据量超过 10 万后重建为 HNSW
