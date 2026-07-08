import { eq } from "drizzle-orm";
import { generateObject } from "ai";
import { hookTemplates, ulid, type Db } from "@ytauto/db";
import { DEFAULT_HOOK_TEMPLATES, hookIngestSchema, hookPickSchema } from "@ytauto/core";
import type { ResearchProvider } from "@ytauto/providers";
import { runAgent, type AgentCtx, repairDoubleEncodedJson } from "./run-agent";

type HookTemplate = typeof hookTemplates.$inferSelect;

/** Seed the four default archetypes so the library works pre-ingestion. */
export async function ensureDefaultHookTemplates(db: Db): Promise<void> {
  for (const t of DEFAULT_HOOK_TEMPLATES) {
    await db
      .insert(hookTemplates)
      .values({ id: t.id, name: t.name, archetype: t.archetype, skeleton: t.skeleton })
      .onConflictDoNothing();
  }
}

/**
 * Per-topic hook selection (spec §5.5): "scorer picks per topic". Cheap tier;
 * falls back to the first active template if the pick is invalid.
 */
export async function pickHookTemplate(
  ctx: AgentCtx,
  idea: { title: string; angle: string },
): Promise<HookTemplate> {
  await ensureDefaultHookTemplates(ctx.db);
  const templates = await ctx.db
    .select()
    .from(hookTemplates)
    .where(eq(hookTemplates.active, true));
  if (templates.length === 0) throw new Error("No active hook templates");

  const prompt = [
    `IDEA TITLE: ${idea.title}`,
    `IDEA ANGLE: ${idea.angle}`,
    "",
    ...templates.map(
      (t) =>
        `TEMPLATE id=${t.id} name="${t.name}" archetype=${t.archetype} first2s="${t.skeleton.first2s}"`,
    ),
  ].join("\n");

  const pick = await runAgent(
    "hook_picker",
    "cheap",
    ctx,
    `pick hook for: ${idea.title}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: hookPickSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:hook-pick — Choose the hook template whose opening pattern best fits this topic. Curiosity gaps for mysteries, stakes for costly mistakes, contrarian for misconceptions, pattern interrupts for visually surprising facts.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  return templates.find((t) => t.id === pick.templateId) ?? templates[0]!;
}

/**
 * Hook-library ingestion (spec §5.5): abstract the STRUCTURE of
 * high-retention videos into reusable, content-free templates.
 */
export async function ingestHookTemplates(ctx: AgentCtx, research: ResearchProvider, niche: string) {
  const outliers = await research.outliers(niche);
  const prompt = [
    `NICHE: ${niche}`,
    ...outliers.map((o) => `OUTLIER: ${o.title} (${o.views} views, x${o.outlierFactor})`),
  ].join("\n");

  const out = await runAgent(
    "hook_ingest",
    "agentic",
    ctx,
    `ingest hook structures for niche: ${niche}`,
    async (model) => {
      const res = await generateObject({
        model,
        schema: hookIngestSchema,
        experimental_repairText: repairDoubleEncodedJson,
        system:
          "TASK:hook-ingest — Abstract the STRUCTURE of these high-performing videos into reusable templates: hook type, first-1-2s pattern, retention beats, payoff placement, loop/CTA. Structure only — no topic-specific content may leak into the skeleton.",
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );

  const rows = out.templates.map((t) => ({
    id: ulid(),
    name: t.name,
    archetype: t.archetype,
    skeleton: {
      first2s: t.first2s,
      beatPlan: t.beatPlan,
      payoffPlacement: t.payoffPlacement,
      loopOrCta: t.loopOrCta,
    },
    sourceRef: t.sourceRef,
  }));
  if (rows.length) await ctx.db.insert(hookTemplates).values(rows);
  return rows;
}
