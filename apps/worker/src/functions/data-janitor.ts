import { and, eq, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  agentActions,
  alerts,
  citations,
  episodes,
  memoryChunks,
  scriptDrafts,
} from "@ytauto/db";
import { capacityStatus, inngest } from "@ytauto/core";
import { getContext } from "../context";

/**
 * Data-retention janitor + capacity watch (BACKLOG #21.7).
 *
 * Retention principle: keep what informs future output (scripts, briefs,
 * coverage summaries, analytics, patterns, costs); expire spent fuel. An
 * episode's raw research (episode-scoped memory chunks — text + 1536-dim
 * vectors, the #1 storage driver) is read ONLY while producing that episode;
 * 30 days after it is published/cut it is deleted. The channel-scoped
 * coverage summary remains the durable "what we said" for dedup + follow-ups.
 *
 * Capacity: storage % of the plan quota (DB_STORAGE_GB, default 10) and the
 * Postgres cache-hit ratio surface as platform alerts (channelId null) at
 * 70%/85% — the "warn me in the platform" flag, not a silent limit.
 */

/** episode-scoped research chunks: days after the episode goes terminal */
const RESEARCH_TTL_DAYS = 30;
/** full LLM output payloads on routine agent rows */
const AGENT_OUTPUT_TTL_DAYS = 90;
/** evidence-class rows keep payloads longer — they are the compliance trail */
const EVIDENCE_TTL_DAYS = 365;
/** citation snippet text (url/domain/title provenance stays forever) */
const CITATION_SNIPPET_TTL_DAYS = 90;
/** superseded script drafts (the latest per production always stays) */
const DRAFT_TTL_DAYS = 30;

const EVIDENCE_AGENTS = [
  "factuality_check",
  "factuality_proof",
  "variation_check",
  "review_board",
  "board_compliance",
  "board_alignment",
  "board_safety",
  "board_quality",
  "operator_override",
  "data_janitor",
];

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

export const dataJanitor = inngest.createFunction(
  { id: "data-janitor", retries: 2 },
  [{ cron: "30 15 * * *" }, { event: "ops/janitor.requested" }], // 15:30 UTC ≈ 1:30am AEST
  async ({ step }) => {
    // 1) expire episode-scoped research for terminal episodes (#1 driver)
    const researchExpired = await step.run("expire-episode-research", async () => {
      const { db } = await getContext();
      const terminal = db
        .select({ id: episodes.id })
        .from(episodes)
        .where(
          and(inArray(episodes.status, ["published", "cut"]), lt(episodes.updatedAt, daysAgo(RESEARCH_TTL_DAYS))),
        );
      const gone = await db
        .delete(memoryChunks)
        .where(
          and(
            eq(memoryChunks.scope, "episode"),
            isNotNull(memoryChunks.episodeId),
            inArray(memoryChunks.episodeId, terminal),
          ),
        )
        .returning({ id: memoryChunks.id });
      return gone.length;
    });

    // 2) strip routine LLM output payloads (#2 driver); evidence keeps 1y
    const outputsStripped = await step.run("strip-agent-outputs", async () => {
      const { db } = await getContext();
      const routine = await db
        .update(agentActions)
        .set({ output: null })
        .where(
          and(
            isNotNull(agentActions.output),
            lt(agentActions.createdAt, daysAgo(AGENT_OUTPUT_TTL_DAYS)),
            notInArray(agentActions.agentName, EVIDENCE_AGENTS),
          ),
        )
        .returning({ id: agentActions.id });
      const evidence = await db
        .update(agentActions)
        .set({ output: null })
        .where(
          and(
            isNotNull(agentActions.output),
            lt(agentActions.createdAt, daysAgo(EVIDENCE_TTL_DAYS)),
            inArray(agentActions.agentName, EVIDENCE_AGENTS),
          ),
        )
        .returning({ id: agentActions.id });
      return routine.length + evidence.length;
    });

    // 3) trim citation snippets (keep url/domain/title provenance)
    const snippetsTrimmed = await step.run("trim-citation-snippets", async () => {
      const { db } = await getContext();
      const rows = await db
        .update(citations)
        .set({ snippet: "" })
        .where(and(ne(citations.snippet, ""), lt(citations.createdAt, daysAgo(CITATION_SNIPPET_TTL_DAYS))))
        .returning({ id: citations.id });
      return rows.length;
    });

    // 4) prune superseded script drafts (latest per production stays — resume
    // and the approved script both read the latest version)
    const draftsPruned = await step.run("prune-script-drafts", async () => {
      const { db } = await getContext();
      const rows = await db.execute(sql`
        DELETE FROM script_drafts sd
        USING (
          SELECT production_id, max(version) AS keep_version
          FROM script_drafts GROUP BY production_id
        ) latest
        WHERE sd.production_id = latest.production_id
          AND sd.version < latest.keep_version
          AND sd.created_at < ${daysAgo(DRAFT_TTL_DAYS).toISOString()}::timestamptz
        RETURNING sd.id
      `);
      return rows.length ?? 0;
    });

    // 5) capacity watch → platform alert (dedup: one open capacity alert)
    const capacity = await step.run("capacity-check", async () => {
      const { db } = await getContext();
      const [size] = (await db.execute(
        sql`SELECT pg_database_size(current_database())::bigint AS bytes`,
      )) as unknown as { bytes: string | number }[];
      const [cache] = (await db.execute(sql`
        SELECT CASE WHEN sum(blks_hit) + sum(blks_read) = 0 THEN NULL
               ELSE sum(blks_hit)::float / (sum(blks_hit) + sum(blks_read)) END AS ratio
        FROM pg_stat_database WHERE datname = current_database()
      `)) as unknown as { ratio: number | null }[];

      const status = capacityStatus({
        usedBytes: Number(size?.bytes ?? 0),
        quotaGb: Number(process.env.DB_STORAGE_GB ?? 10),
        cacheHitRatio: cache?.ratio ?? null,
      });

      const [openCapacity] = await db
        .select()
        .from(alerts)
        .where(and(eq(alerts.kind, "capacity"), eq(alerts.status, "open")));
      if (status.level === "ok") return status;
      if (openCapacity) {
        // escalate an existing open alert's severity/message in place
        await db
          .update(alerts)
          .set({ severity: status.level, message: status.message! })
          .where(eq(alerts.id, openCapacity.id));
        return status;
      }
      await db.insert(alerts).values({
        id: ulid(),
        channelId: null,
        kind: "capacity",
        severity: status.level,
        message: status.message!,
      });
      return status;
    });

    // 6) auditable shrink: what this run reclaimed
    await step.run("log-run", async () => {
      const { db } = await getContext();
      await db.insert(agentActions).values({
        id: ulid(),
        agentName: "data_janitor",
        inputSummary: "nightly data-retention sweep + capacity check (#21.7)",
        output: {
          researchExpired,
          outputsStripped,
          snippetsTrimmed,
          draftsPruned,
          capacity,
        },
      });
    });

    return { researchExpired, outputsStripped, snippetsTrimmed, draftsPruned, capacity };
  },
);
