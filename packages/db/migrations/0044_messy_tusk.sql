CREATE TABLE "fx_rates" (
	"date" text PRIMARY KEY NOT NULL,
	"usd_to_aud" real NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
