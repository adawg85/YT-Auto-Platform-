CREATE TABLE "service_versions" (
	"service" text PRIMARY KEY NOT NULL,
	"commit" text NOT NULL,
	"booted_at" timestamp with time zone DEFAULT now() NOT NULL
);
