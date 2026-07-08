import { and, desc, eq } from "drizzle-orm";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import {
  agentActions,
  alerts,
  assets,
  channelCharters,
  channels,
  ideas,
  productions,
  reviewGates,
  scriptDrafts,
  thumbnails,
  ulid,
  type Db,
} from "@ytauto/db";
import {
  channelPerformanceSummary,
  inngest,
  type CostSink,
} from "@ytauto/core";
import { llmCostUsd, type LLMProvider } from "@ytauto/providers";

export type ControlDeps = {
  db: Db;
  llm: LLMProvider;
  costSink: CostSink;
  operator: string;
};

/** Land 3: copy a source production's media (+ thumbnails) onto a new one,
 * keeping storage keys so the pipeline reuses them (mirrors the cockpit action). */
async function copyProductionMedia(db: Db, sourceId: string, newId: string) {
  const srcAssets = await db.select().from(assets).where(eq(assets.productionId, sourceId));
  if (srcAssets.length) {
    await db.insert(assets).values(
      srcAssets.map((a) => ({
        id: ulid(),
        productionId: newId,
        kind: a.kind,
        idx: a.idx,
        storageKey: a.storageKey,
        mimeType: a.mimeType,
        durationSec: a.durationSec,
        meta: a.meta,
      })),
    );
  }
  const srcThumbs = await db.select().from(thumbnails).where(eq(thumbnails.productionId, sourceId));
  if (srcThumbs.length) {
    await db.insert(thumbnails).values(
      srcThumbs.map((t) => ({
        id: ulid(),
        productionId: newId,
        storageKey: t.storageKey,
        selected: t.selected,
        predictedCtr: t.predictedCtr,
      })),
    );
  }
}

/**
 * Conversational agent control (spec §5.6): natural language over the
 * platform's own action API via tool-calling. Every run is logged as an
 * AgentAction; every mutating tool writes the same rows the cockpit
 * buttons write, so the audit trail is identical.
 */
export async function runControl(deps: ControlDeps, message: string): Promise<string> {
  const { db } = deps;

  const tools = {
    list_channels: tool({
      description: "List all channels with niche, autonomy tier, and status",
      inputSchema: z.object({}),
      execute: async () => db.select().from(channels),
    }),
    list_pending_gates: tool({
      description: "List review gates waiting for an operator decision",
      inputSchema: z.object({}),
      execute: async () =>
        db
          .select({
            gateId: reviewGates.id,
            kind: reviewGates.kind,
            productionId: reviewGates.productionId,
            createdAt: reviewGates.createdAt,
          })
          .from(reviewGates)
          .where(eq(reviewGates.status, "pending")),
    }),
    decide_gate: tool({
      description: "Approve, reject, or request revision on a pending review gate",
      inputSchema: z.object({
        gateId: z.string(),
        decision: z.enum(["approved", "rejected", "revise"]),
        notes: z.string().describe("editorial notes; required for revise"),
      }),
      execute: async ({ gateId, decision, notes }) => {
        const [gate] = await db.select().from(reviewGates).where(eq(reviewGates.id, gateId));
        if (!gate || gate.status !== "pending") return { error: "gate not found or not pending" };
        await db
          .update(reviewGates)
          .set({ status: "decided", decision, notes, decidedBy: deps.operator, decidedAt: new Date() })
          .where(eq(reviewGates.id, gateId));
        await inngest.send({
          name: "production/gate.decided",
          data: { productionId: gate.productionId, gateId, kind: gate.kind, decision, notes },
        });
        return { ok: true, gateId, decision };
      },
    }),
    list_ideas: tool({
      description: "List recent ideas in the backlog with status and fast-track flag",
      inputSchema: z.object({ channelId: z.string().optional() }),
      execute: async ({ channelId }) => {
        const rows = await db.select().from(ideas).orderBy(desc(ideas.createdAt)).limit(30);
        return channelId ? rows.filter((r) => r.channelId === channelId) : rows;
      },
    }),
    greenlight_idea: tool({
      description: "Greenlight an idea: creates a production and starts the pipeline",
      inputSchema: z.object({ ideaId: z.string() }),
      execute: async ({ ideaId }) => {
        const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
        if (!idea) return { error: "idea not found" };
        const productionId = ulid();
        await db
          .insert(productions)
          .values({ id: productionId, ideaId, channelId: idea.channelId, status: "greenlit" });
        await db.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, ideaId));
        await inngest.send({ name: "production/greenlit", data: { productionId } });
        return { ok: true, productionId };
      },
    }),
    halt_production: tool({
      description:
        "Halt a production at any stage and return its idea to the greenlightable pool (idea → scored). Cancels any in-flight run and keeps the production as a resumable draft with all its artifacts. Use to recover a stuck or unwanted production without losing the idea.",
      inputSchema: z.object({ productionId: z.string() }),
      execute: async ({ productionId }) => {
        const [prod] = await db.select().from(productions).where(eq(productions.id, productionId));
        if (!prod) return { error: "production not found" };
        await db
          .update(reviewGates)
          .set({ status: "expired" })
          .where(and(eq(reviewGates.productionId, productionId), eq(reviewGates.status, "pending")));
        await db
          .update(productions)
          .set({ status: "halted", currentGateId: null, inngestRunId: null, failureReason: null })
          .where(eq(productions.id, productionId));
        await db.update(ideas).set({ status: "scored" }).where(eq(ideas.id, prod.ideaId));
        await inngest.send({ name: "production/halt", data: { productionId } });
        return { ok: true, productionId, ideaId: prod.ideaId };
      },
    }),
    resume_production: tool({
      description:
        "Resume a halted production by reusing its kept script on a fresh production and regenerating media. Skips drafting and the script review. Returns the new production id.",
      inputSchema: z.object({ productionId: z.string().describe("the halted production to resume") }),
      execute: async ({ productionId }) => {
        const [halted] = await db.select().from(productions).where(eq(productions.id, productionId));
        if (!halted) return { error: "production not found" };
        const [draft] = await db
          .select()
          .from(scriptDrafts)
          .where(eq(scriptDrafts.productionId, productionId))
          .orderBy(desc(scriptDrafts.version))
          .limit(1);
        if (!draft) return { error: "no script to reuse — greenlight the idea fresh instead" };
        const newId = ulid();
        await db.insert(productions).values({
          id: newId,
          ideaId: halted.ideaId,
          channelId: halted.channelId,
          status: "greenlit",
          substanceFingerprint: halted.substanceFingerprint,
        });
        await db.insert(scriptDrafts).values({
          id: ulid(),
          productionId: newId,
          version: 1,
          hookTemplateId: draft.hookTemplateId,
          hookText: draft.hookText,
          beats: draft.beats,
          fullText: draft.fullText,
          wordCount: draft.wordCount,
        });
        await copyProductionMedia(db, productionId, newId);
        await db.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, halted.ideaId));
        await inngest.send({ name: "production/greenlit", data: { productionId: newId } });
        return { ok: true, productionId: newId, reusedFrom: productionId };
      },
    }),
    force_forward_production: tool({
      description:
        "Force a blocked (on_hold/failed/rejected) production forward: re-run from its script with the soft safety gates (variation + review board) bypassed. Only use when the operator has reviewed the flag and explicitly asked to override. Logged for compliance.",
      inputSchema: z.object({ productionId: z.string().describe("the blocked production to force forward") }),
      execute: async ({ productionId }) => {
        const [blocked] = await db.select().from(productions).where(eq(productions.id, productionId));
        if (!blocked) return { error: "production not found" };
        const [draft] = await db
          .select()
          .from(scriptDrafts)
          .where(eq(scriptDrafts.productionId, productionId))
          .orderBy(desc(scriptDrafts.version))
          .limit(1);
        if (!draft) return { error: "no script yet — fix the blocking claims or greenlight fresh" };
        const newId = ulid();
        await db.insert(productions).values({
          id: newId,
          ideaId: blocked.ideaId,
          channelId: blocked.channelId,
          status: "greenlit",
          substanceFingerprint: blocked.substanceFingerprint,
          bypassChecks: true,
        });
        await db.insert(scriptDrafts).values({
          id: ulid(),
          productionId: newId,
          version: 1,
          hookTemplateId: draft.hookTemplateId,
          hookText: draft.hookText,
          beats: draft.beats,
          fullText: draft.fullText,
          wordCount: draft.wordCount,
        });
        await copyProductionMedia(db, productionId, newId);
        await db.update(ideas).set({ status: "greenlit" }).where(eq(ideas.id, blocked.ideaId));
        await inngest.send({ name: "production/greenlit", data: { productionId: newId } });
        return { ok: true, productionId: newId, overrodeFrom: productionId };
      },
    }),
    generate_ideas: tool({
      description: "Queue idea generation — tell the operator to press the button for the given channel (agent-side generation runs from the Ideas page)",
      inputSchema: z.object({ channelId: z.string().optional() }),
      execute: async () => ({
        hint: "Idea generation runs from the Ideas page button in v1; queueing from chat arrives with the ideation event refactor.",
      }),
    }),
    channel_performance: tool({
      description: "Get the performance summary for a channel (views, retention, best/worst)",
      inputSchema: z.object({ channelId: z.string().optional() }),
      execute: async ({ channelId }) => {
        const all = await db.select().from(channels);
        const targets = channelId ? all.filter((c) => c.id === channelId) : all;
        const out = [];
        for (const c of targets) {
          out.push({ channel: c.name, ...(await channelPerformanceSummary(db, c.id)) });
        }
        return out;
      },
    }),
    set_channel_autonomy: tool({
      description: "Set a channel's autonomy tier (0 manual … 3 exception-only)",
      inputSchema: z.object({ channelId: z.string(), tier: z.number().min(0).max(3) }),
      execute: async ({ channelId, tier }) => {
        await db.update(channels).set({ autonomyTier: tier }).where(eq(channels.id, channelId));
        return { ok: true, channelId, tier };
      },
    }),
    get_charter: tool({
      description: "Read a channel's charter — mission and current objectives/targets",
      inputSchema: z.object({ channelId: z.string() }),
      execute: async ({ channelId }) => {
        const [c] = await db.select().from(channelCharters).where(eq(channelCharters.channelId, channelId));
        if (!c) return { error: "no charter for this channel" };
        return { mission: c.mission, objectives: c.objectives, archetype: c.archetype };
      },
    }),
    update_charter_objectives: tool({
      description:
        "Replace a channel's charter objectives/targets with a new list (e.g. after the operator asks to make targets more aggressive). Pass the FULL new list.",
      inputSchema: z.object({
        channelId: z.string(),
        objectives: z.array(z.string()).describe("the complete new objectives list, one target per item"),
      }),
      execute: async ({ channelId, objectives }) => {
        await db
          .update(channelCharters)
          .set({ objectives: objectives.slice(0, 12) })
          .where(eq(channelCharters.channelId, channelId));
        return { ok: true, channelId, objectives: objectives.slice(0, 12) };
      },
    }),
    run_plan_research: tool({
      description: "Kick off the editorial planner + research for a channel (drafts the next series arc)",
      inputSchema: z.object({ channelId: z.string() }),
      execute: async ({ channelId }) => {
        await inngest.send({ name: "editorial/plan.requested", data: { channelId } });
        return { ok: true, note: "planning/research queued" };
      },
    }),
    list_alerts: tool({
      description: "List open alerts from the monitoring rail",
      inputSchema: z.object({}),
      execute: async () => db.select().from(alerts).where(eq(alerts.status, "open")),
    }),
    ack_alert: tool({
      description: "Acknowledge an open alert",
      inputSchema: z.object({ alertId: z.string() }),
      execute: async ({ alertId }) => {
        await db
          .update(alerts)
          .set({ status: "acked", ackedAt: new Date() })
          .where(eq(alerts.id, alertId));
        return { ok: true };
      },
    }),
    run_analytics_ingest: tool({
      description: "Trigger an analytics ingest run now (snapshots + alert rules)",
      inputSchema: z.object({}),
      execute: async () => {
        await inngest.send({ name: "analytics/ingest.requested", data: {} });
        return { ok: true, note: "ingest queued" };
      },
    }),
    run_trend_scan: tool({
      description: "Trigger a trend scan now (fast-lane idea detection)",
      inputSchema: z.object({ channelId: z.string().optional() }),
      execute: async ({ channelId }) => {
        await inngest.send({ name: "trend/scan.requested", data: { channelId } });
        return { ok: true, note: "trend scan queued" };
      },
    }),
  };

  const started = Date.now();
  const model = deps.llm.model("agentic");
  const modelId = deps.llm.modelId("agentic");

  const result = await generateText({
    model,
    tools,
    stopWhen: stepCountIs(5),
    system:
      "TASK:control — You are the operator's control-plane assistant for a faceless-YouTube automation platform. " +
      "Resolve instructions to concrete tool calls against the platform's action API, then summarise what you did or found in plain language. " +
      "Mutations (deciding gates, greenlighting, halting/resuming productions, editing charter objectives, running the planner, changing autonomy) must reflect exactly what the operator asked — never invent targets. " +
      "When asked to change charter targets, first read the current charter (get_charter), then update_charter_objectives with the FULL revised list. " +
      "If a request is ambiguous, ask instead of guessing.",
    prompt: message,
  });

  const usage = {
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
  };
  const costUsd = llmCostUsd(modelId, usage);
  const agentActionId = ulid();
  await db.insert(agentActions).values({
    id: agentActionId,
    agentName: "control",
    tier: "agentic",
    model: modelId,
    inputSummary: message.slice(0, 500),
    output: { text: result.text, steps: result.steps.length },
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: costUsd.toFixed(6),
    durationMs: Date.now() - started,
  });
  await deps.costSink.record({
    category: "llm",
    provider: deps.llm.name,
    model: modelId,
    units: usage,
    costUsd,
    channelId: "platform", // control-plane actions are not channel-scoped
    agentActionId,
  });

  return result.text || "(no reply)";
}
