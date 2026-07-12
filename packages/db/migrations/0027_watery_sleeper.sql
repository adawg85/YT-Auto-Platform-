CREATE TYPE "public"."eval_result_status" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."eval_run_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"fixture_id" text NOT NULL,
	"model_ref" text NOT NULL,
	"status" "eval_result_status" DEFAULT 'ok' NOT NULL,
	"error" text,
	"script" jsonb,
	"judge" jsonb,
	"metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "eval_run_status" DEFAULT 'running' NOT NULL,
	"models" jsonb NOT NULL,
	"fixture_count" integer DEFAULT 0 NOT NULL,
	"note" text,
	"error" text,
	"concluded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"fixture_id" text NOT NULL,
	"winner_result_id" text NOT NULL,
	"loser_result_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_votes" ADD CONSTRAINT "eval_votes_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_votes" ADD CONSTRAINT "eval_votes_winner_result_id_eval_results_id_fk" FOREIGN KEY ("winner_result_id") REFERENCES "public"."eval_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_votes" ADD CONSTRAINT "eval_votes_loser_result_id_eval_results_id_fk" FOREIGN KEY ("loser_result_id") REFERENCES "public"."eval_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_results_run_id_idx" ON "eval_results" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_results_identity_uq" ON "eval_results" USING btree ("run_id","fixture_id","model_ref");