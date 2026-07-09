-- V000: 扩展安装 + UUIDv7 函数
-- PostgreSQL 原生不支持 UUIDv7，使用基于时间戳的生成函数

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE OR REPLACE FUNCTION gen_uuid_v7() RETURNS uuid AS $$
DECLARE
  ts_ms bigint;
  ts_hex text;
  rand_hex text;
BEGIN
  -- 当前毫秒级 Unix 时间戳
  ts_ms := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  -- 时间戳转换为 12 位十六进制（48 bits）
  ts_hex := lpad(to_hex(ts_ms), 12, '0');
  -- 随机部分：10 位十六进制（40 bits），版本 7 + 变体位保留
  rand_hex := lpad(to_hex((random() * 2^40)::bigint), 10, '0');
  -- 版本 7 标记（第 7 个字符位置置 7）
  rand_hex := overlay(rand_hex placing '7' from 1 for 1);
  RETURN (ts_hex || rand_hex)::uuid;
END;
$$ LANGUAGE plpgsql;

-- 迁移记录表
CREATE TABLE IF NOT EXISTS _migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
