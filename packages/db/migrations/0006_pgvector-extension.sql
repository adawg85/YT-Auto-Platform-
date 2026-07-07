-- Build #5: semantic per-channel memory lives in pgvector (same Postgres, no
-- separate vector DB). Requires the pgvector/pgvector:pg16 image (or the
-- extension installed) — see docker-compose*.yml and DEPLOY.md.
CREATE EXTENSION IF NOT EXISTS vector;
