import { eq, and, desc } from "drizzle-orm";
import { generateObject } from "ai";
import { channelDna, personas, ulid, type Db, type PersonaDoc } from "@ytauto/db";
import {
  PERSONA_ARCHETYPE_LIBRARY,
  defaultPersonaDoc,
  personaProposalSchema,
  type FactualityMode,
  type PersonaArchetype,
  type PersonaProposal,
} from "@ytauto/core";
import { temperatureFor } from "@ytauto/providers";
import { runAgent, repairDoubleEncodedJson, type AgentCtx } from "./run-agent";

/**
 * Persona generator (BACKLOG #21.1, frontier tier): specialise an archetype
 * seed into THIS channel's writing persona — one specific human voice with
 * niche-specific identity, rules, and exemplar passages. Also produces
 * tweaked versions (v n+1) when `tweakNotes` are given, keeping the persona
 * recognisably the same person.
 */
export async function generatePersona(
  ctx: AgentCtx,
  input: {
    archetype: PersonaArchetype;
    niche: string;
    tone?: string | null;
    audiencePersona?: string | null;
    factualityMode: FactualityMode;
    /** for agent-proposed v(n+1): what to change and why */
    tweakNotes?: string;
    /** the current doc when tweaking */
    baseDoc?: PersonaDoc;
  },
): Promise<PersonaProposal> {
  const seed = PERSONA_ARCHETYPE_LIBRARY[input.archetype];
  const system =
    "TASK:persona — You design the writing persona for a faceless YouTube channel: ONE specific " +
    "human voice that every episode will be written in. Start from the ARCHETYPE seed but make it " +
    "belong to this channel — the identity, voice rules, and exemplars must be niche-specific; a " +
    "generic channel could not use them. The EXEMPLARS matter most: 1-3 passages (2-4 sentences " +
    "each) that sound like a person talking out loud, never like marketing copy — uneven rhythm, " +
    "a real point of view, words chosen in the moment. Respect the channel's factuality mode: " +
    "strict = measured, evidence-first; balanced = comfortable saying 'no one knows' and leaning " +
    "into mystery; entertainment = fun-first, playful. The avoid-list must keep the archetype's " +
    "AI-tell phrases. When TWEAK NOTES are given, produce a new version that stays recognisably " +
    "the SAME person while applying only that tweak.";

  const prompt = [
    `NICHE: ${input.niche}`,
    input.tone ? `CHANNEL TONE: ${input.tone}` : "",
    input.audiencePersona ? `AUDIENCE: ${input.audiencePersona}` : "",
    `FACTUALITY MODE: ${input.factualityMode}`,
    `ARCHETYPE: ${input.archetype} (${seed.label} — ${seed.blurb})`,
    `ARCHETYPE SEED (starting point, specialise it):\n${JSON.stringify(seed.seed(input.niche), null, 2)}`,
    input.baseDoc ? `CURRENT PERSONA (the person to keep recognisable):\n${JSON.stringify(input.baseDoc, null, 2)}` : "",
    input.tweakNotes ? `TWEAK NOTES (apply ONLY this change): ${input.tweakNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return runAgent(
    "persona_generator",
    "frontier",
    ctx,
    `generate persona (${input.archetype}) for niche: ${input.niche}`,
    async (model, modelId) => {
      const res = await generateObject({
        model,
        schema: personaProposalSchema,
        experimental_repairText: repairDoubleEncodedJson,
        temperature: temperatureFor(modelId, "creative"),
        system,
        prompt,
      });
      return { object: res.object, usage: res.usage };
    },
  );
}

export type ActivePersona = {
  id: string;
  version: number;
  name: string;
  archetype: string;
  doc: PersonaDoc;
};

/**
 * Load the channel's ACTIVE persona; if none exists (legacy channels, or a
 * dangling pointer), synthesise a deterministic v1 from the archetype library
 * (no LLM — fail-safe) using the channel's niche, activate it, and return it.
 */
export async function ensureActivePersona(
  db: Db,
  channelId: string,
  fallback: { niche: string; archetype?: PersonaArchetype },
): Promise<ActivePersona> {
  const [dna] = await db.select().from(channelDna).where(eq(channelDna.channelId, channelId));
  if (dna?.activePersonaId) {
    const [row] = await db.select().from(personas).where(eq(personas.id, dna.activePersonaId));
    if (row) {
      return { id: row.id, version: row.version, name: row.name, archetype: row.archetype, doc: row.doc };
    }
  }
  // any previously-created active persona for this channel (pointer lost)?
  const [existing] = await db
    .select()
    .from(personas)
    .where(and(eq(personas.channelId, channelId), eq(personas.status, "active")))
    .orderBy(desc(personas.version))
    .limit(1);
  if (existing) {
    if (dna) {
      await db
        .update(channelDna)
        .set({ activePersonaId: existing.id })
        .where(eq(channelDna.channelId, channelId));
    }
    return {
      id: existing.id,
      version: existing.version,
      name: existing.name,
      archetype: existing.archetype,
      doc: existing.doc,
    };
  }
  // legacy channel: deterministic default, activated
  const archetype = fallback.archetype ?? "documentary_narrator";
  const doc = defaultPersonaDoc(archetype, fallback.niche);
  const id = ulid();
  await db.insert(personas).values({
    id,
    channelId,
    name: PERSONA_ARCHETYPE_LIBRARY[archetype].label,
    archetype,
    version: 1,
    status: "active",
    createdBy: "operator",
    doc,
    rationale: "auto-seeded default for a channel created before personas existed",
  });
  if (dna) {
    await db.update(channelDna).set({ activePersonaId: id }).where(eq(channelDna.channelId, channelId));
  }
  return { id, version: 1, name: PERSONA_ARCHETYPE_LIBRARY[archetype].label, archetype, doc };
}
