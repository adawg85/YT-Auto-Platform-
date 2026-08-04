-- #99 (SECURITY): the MCP receipt could not answer "WHO made this call?".
--
-- Five calls appeared in get_diagnostics.mcpCalls that the operator states he
-- did not make — three of them BILLABLE image generations (2x
-- regenerate_thumbnail, 1x refine_thumbnail), each preceded by its own
-- initialize handshake, i.e. a distinct client session. The receipt rows carry
-- no client identity, no source address and no target, so a forgotten second
-- session of the operator's own is INDISTINGUISHABLE from a leaked URL being
-- used by someone else. That indistinguishability is the defect: the endpoint is
-- a single URL with an embedded token that can publish to the operator's YouTube
-- channels and spend his credits.
--
-- These columns make a call attributable: the client's self-reported
-- name/version from the initialize handshake, a stable per-client id derived
-- from that plus a HASH of the source address (never the address itself), and
-- the channel/production the call actually touched.
ALTER TABLE "mcp_call_log" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_call_log" ADD COLUMN IF NOT EXISTS "client_name" text;--> statement-breakpoint
ALTER TABLE "mcp_call_log" ADD COLUMN IF NOT EXISTS "client_version" text;--> statement-breakpoint
ALTER TABLE "mcp_call_log" ADD COLUMN IF NOT EXISTS "ip_hash" text;--> statement-breakpoint
ALTER TABLE "mcp_call_log" ADD COLUMN IF NOT EXISTS "target_channel_id" text;--> statement-breakpoint
ALTER TABLE "mcp_call_log" ADD COLUMN IF NOT EXISTS "target_production_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_call_log_client_id_idx" ON "mcp_call_log" ("client_id");
