-- #88: an append-only receipt for every MCP tools/call that reaches this server.
--
-- The ticket could not distinguish "the Claude app refused before calling us"
-- from "our server rejected" — `No approval received` is emitted by the app, not
-- by this repo, but the operator had no way to prove that from where they sit,
-- and the failing set grew to include get_production (which is already annotated
-- readOnly), killing the tool-annotation theory.
--
-- With this table the test is decisive: make the failing call, then read
-- get_diagnostics().mcpCalls. No row = the call never arrived (host-side).
-- A row with ok = true = we answered and the reply was dropped in transit.
--
-- Stores no argument CONTENT — only the tool name, the outcome, and the
-- argument byte size (what a payload-limit theory needs).
CREATE TABLE "mcp_call_log" (
  "id" text PRIMARY KEY NOT NULL,
  "tool" text,
  "method" text NOT NULL,
  "ok" boolean NOT NULL,
  "error" text,
  "duration_ms" integer,
  "args_bytes" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "mcp_call_log_created_at_idx" ON "mcp_call_log" ("created_at");--> statement-breakpoint
CREATE INDEX "mcp_call_log_tool_idx" ON "mcp_call_log" ("tool");
