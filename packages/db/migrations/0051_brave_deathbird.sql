CREATE TABLE "stock_rate_budget" (
	"provider" text PRIMARY KEY NOT NULL,
	"tokens" real NOT NULL,
	"capacity" real NOT NULL,
	"refill_per_sec" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_search_cache" (
	"provider" text NOT NULL,
	"query" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_search_cache_pk" ON "stock_search_cache" USING btree ("provider","query");