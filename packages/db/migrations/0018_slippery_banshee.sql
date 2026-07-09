CREATE INDEX "analytics_snapshots_publication_id_idx" ON "analytics_snapshots" USING btree ("publication_id");--> statement-breakpoint
CREATE INDEX "claims_channel_id_idx" ON "claims" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "claims_episode_id_idx" ON "claims" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "cost_records_channel_id_idx" ON "cost_records" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "cost_records_production_id_idx" ON "cost_records" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "ideas_channel_id_idx" ON "ideas" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "productions_channel_id_idx" ON "productions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "productions_idea_id_idx" ON "productions" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "publications_production_id_idx" ON "publications" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "scores_idea_id_idx" ON "scores" USING btree ("idea_id");