import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  channelCharters,
  channelDecisions,
  channelSources,
  channels,
  citations,
  claims,
  episodes,
  ideas,
  memoryChunks,
  productions,
  series,
} from "@ytauto/db";
import {
  decideClaimStatus,
  factsGateApplies,
  ingestMemory,
  inngest,
  minFactsToScript,
  resolveFactualityMode,
  retrieveMemory,
} from "@ytauto/core";
import {
  classifyMemoryScope,
  discoverSources,
  extractClaims,
  scoreIdea,
  verifyClaim,
  writeEpisodeBrief,
} from "@ytauto/agents";
import { getContext } from "../context";

/** Evidence passages considered per claim during verification. */
const VERIFY_TOP_K = 6;
/** Max citations stored per claim. */
const MAX_CITATIONS = 4;

function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Episode research chain (build #5): sources → episode-scoped memory →
 * claim extraction → tiered verification (established needs >= N independent
 * domains; emerging/contested is attributed) → brief → idea handoff into the
 * existing production spine.
 */
export const episodeResearch = inngest.createFunction(
  {
    id: "episode-research",
    // "attack only three at a time": cap to 3 concurrent research runs PER
    // channel, and never run the same episode twice at once.
    concurrency: [
      { limit: 3, key: "event.data.channelId" },
      { limit: 1, key: "event.data.episodeId" },
    ],
    // operator "Stop research" cancels every in-flight run for the channel
    cancelOn: [{ event: "editorial/research.halt", match: "data.channelId" }],
    retries: 2,
  },
  { event: "editorial/episode.research.requested" },
  async ({ event, step }) => {
    const { episodeId } = event.data;

    const ctx0 = await step.run("load-episode", async () => {
      const { db } = await getContext();
      const [row] = await db
        .select({ episode: episodes, s: series, channel: channels, charter: channelCharters })
        .from(episodes)
        .innerJoin(series, eq(episodes.seriesId, series.id))
        .innerJoin(channels, eq(episodes.channelId, channels.id))
        .innerJoin(channelCharters, eq(channelCharters.channelId, episodes.channelId))
        .where(eq(episodes.id, episodeId));
      if (!row) throw new Error(`episode not found: ${episodeId}`);
      // "verifying" is accepted so a re-fired event can RESUME an episode whose
      // previous run died mid-verification (found live 2026-07-11: an episode
      // stuck in "verifying" was unrecoverable — every re-fire skipped here).
      // The chain is idempotent past this point (claims upsert per source), so
      // resuming from the top is safe.
      if (!["planned", "researching", "verifying"].includes(row.episode.status)) {
        return { skip: true as const, reason: `status=${row.episode.status}` };
      }
      await db.update(episodes).set({ status: "researching" }).where(eq(episodes.id, episodeId));
      return {
        skip: false as const,
        episode: row.episode,
        channelId: row.channel.id,
        autonomyTier: row.channel.autonomyTier,
        niche: row.channel.niche,
        charter: row.charter,
      };
    });
    if (ctx0.skip) return { skipped: true, reason: ctx0.reason };
    const { episode, channelId, autonomyTier, charter } = ctx0;

    // 1) + 2) gather evidence. Preferred: a real web search (Tavily) that
    // returns clean text from several INDEPENDENT domains in one call — so the
    // corroboration model has real distinct sources to count. Legacy fallback
    // (no search key): LLM-proposed URLs + brittle single-page scrape.
    let fetched: { sourceRowId: string; url: string; title: string; content: string }[] = [];

    const searched = await step.run("web-search", async () => {
      const { db, providers } = await getContext();
      if (!providers.search) return null; // → legacy path below
      const results = await providers.search.search(`${episode.title}. ${episode.angle}`, {
        maxResults: 8,
        excludeDomains: charter.sourceStrategy.avoidDomains,
        channelId,
      });
      const existing = await db
        .select()
        .from(channelSources)
        .where(eq(channelSources.channelId, channelId));
      const inserted = new Set<string>();
      const out: { sourceRowId: string; url: string; title: string; content: string }[] = [];
      for (const r of results) {
        const config = { url: r.url };
        const keyc = JSON.stringify(config);
        const match = existing.find((e) => e.kind === "web" && JSON.stringify(e.config) === keyc);
        let id: string;
        if (match) {
          id = match.id;
        } else if (inserted.has(keyc)) {
          continue; // same URL twice in one result set
        } else {
          id = ulid();
          await db.insert(channelSources).values({
            id,
            channelId,
            kind: "web",
            name: r.title.slice(0, 200),
            config,
            proposedBy: "agent",
          });
          inserted.add(keyc);
        }
        await db
          .update(channelSources)
          .set({ lastFetchAt: new Date(), status: "active", lastError: null })
          .where(eq(channelSources.id, id));
        out.push({ sourceRowId: id, url: r.url, title: r.title, content: r.content });
      }
      return out;
    });

    if (searched) {
      fetched = searched;
    } else {
      // LEGACY: LLM proposes episode-specific sources, tracked as channel_sources
      const sources = await step.run("discover-sources", async () => {
        const { db, providers, costSink } = await getContext();
        const ctx = { db, llm: providers.llm, costSink, channelId };
        const discovery = await discoverSources(ctx, {
          topic: episode.title,
          angle: episode.angle,
          strategy: charter.sourceStrategy,
        });
        const proposed = discovery.sources.filter(
          (s) => !charter.sourceStrategy.avoidDomains.some((d) => s.url.includes(d)),
        );
        const existing = await db
          .select()
          .from(channelSources)
          .where(eq(channelSources.channelId, channelId));
        const rows = [];
        for (const s of proposed) {
          const config = s.kind === "youtube" ? { query: s.query || episode.title } : { url: s.url };
          const match = existing.find(
            (e) => e.kind === s.kind && JSON.stringify(e.config) === JSON.stringify(config),
          );
          if (match) {
            rows.push({ id: match.id, kind: match.kind, config: match.config });
            continue;
          }
          const id = ulid();
          await db.insert(channelSources).values({
            id,
            channelId,
            kind: s.kind,
            name: s.name,
            config,
            proposedBy: "agent",
          });
          rows.push({ id, kind: s.kind, config });
        }
        return rows;
      });

      // fetch each source; failures are tracked on the row, never fatal
      for (const src of sources) {
        const items = await step.run(`fetch-source-${src.id}`, async () => {
          const { db, providers } = await getContext();
          try {
            const connector = providers.sources[src.kind as "rss" | "web" | "youtube"];
            const items = await connector.fetchItems(src.config as Record<string, unknown>, {
              query: episode.title,
              limit: 5,
            });
            await db
              .update(channelSources)
              .set({ lastFetchAt: new Date(), status: "active", lastError: null })
              .where(eq(channelSources.id, src.id));
            return items.map((i) => ({
              sourceRowId: src.id,
              url: i.url,
              title: i.title,
              content: i.content,
            }));
          } catch (err) {
            const [row] = await db
              .select()
              .from(channelSources)
              .where(eq(channelSources.id, src.id));
            await db
              .update(channelSources)
              .set({
                status: "error",
                lastError: err instanceof Error ? err.message : String(err),
                errorCount: (row?.errorCount ?? 0) + 1,
              })
              .where(eq(channelSources.id, src.id));
            return [];
          }
        });
        fetched.push(...items);
      }
    }

    // 3) ingest into EPISODE-scoped semantic memory (the raw research dump)
    await step.run("ingest-memory", async () => {
      const { db, providers } = await getContext();
      let chunks = 0;
      for (const item of fetched) {
        const ids = await ingestMemory(db, providers.embeddings, {
          channelId,
          episodeId,
          scope: "episode",
          kind: "source_doc",
          title: item.title,
          content: item.content,
          sourceUrl: item.url,
          meta: { sourceRowId: item.sourceRowId },
        });
        chunks += ids.length;
      }
      return { documents: fetched.length, chunks };
    });

    // 4) extract atomic claims from the evidence
    const extractedIds = await step.run("extract-claims", async () => {
      const { db, providers, costSink } = await getContext();
      const ctx = { db, llm: providers.llm, costSink, channelId };
      const evidence = fetched.map((f) => f.content.slice(0, 2400));
      if (evidence.length === 0) return [];
      const extraction = await extractClaims(ctx, { topic: episode.title, evidence });
      const rows = extraction.claims.map((c) => ({
        id: ulid(),
        episodeId,
        channelId,
        text: c.text,
        tier: c.tier,
      }));
      if (rows.length) await db.insert(claims).values(rows);
      await db.update(episodes).set({ status: "verifying" }).where(eq(episodes.id, episodeId));
      return rows.map((r) => r.id);
    });

    // 5) tiered verification: per claim, retrieve evidence, verify per passage,
    //    count DISTINCT supporting domains, decide verified/attributed/cut
    for (const claimId of extractedIds) {
      await step.run(`verify-claim-${claimId}`, async () => {
        const { db, providers, costSink } = await getContext();
        const ctx = { db, llm: providers.llm, costSink, channelId };
        const [claim] = await db.select().from(claims).where(eq(claims.id, claimId));
        if (!claim || claim.status !== "unverified") return { skipped: true };

        const hits = await retrieveMemory(db, providers.embeddings, {
          channelId,
          episodeId,
          query: claim.text,
          k: VERIFY_TOP_K,
        });

        const supporting: { url: string; title: string; domain: string; snippet: string }[] = [];
        const seenDomains = new Set<string>();
        for (const hit of hits) {
          const domain = domainOf(hit.sourceUrl);
          if (!domain || seenDomains.has(domain)) continue;
          const verdict = await verifyClaim(ctx, { claim: claim.text, evidence: hit.content });
          if (verdict.supported) {
            seenDomains.add(domain);
            supporting.push({
              url: hit.sourceUrl!,
              title: hit.title,
              domain,
              snippet: verdict.snippet || hit.content.slice(0, 200),
            });
          }
        }

        const status = decideClaimStatus(claim.tier, seenDomains.size, charter.verificationBar);
        await db.update(claims).set({ status }).where(eq(claims.id, claimId));
        if (status !== "cut" && supporting.length) {
          await db.insert(citations).values(
            supporting.slice(0, MAX_CITATIONS).map((s) => ({
              id: ulid(),
              claimId,
              url: s.url,
              title: s.title,
              domain: s.domain,
              snippet: s.snippet,
            })),
          );
        }
        return { status, domains: seenDomains.size };
      });
    }

    // 6) brief from surviving claims — or cut the episode if nothing survived
    const briefResult = await step.run("write-brief", async () => {
      const { db, providers, costSink } = await getContext();
      const ctx = { db, llm: providers.llm, costSink, channelId };
      const allClaims = await db.select().from(claims).where(eq(claims.episodeId, episodeId));
      const usable = allClaims.filter((c) => c.status === "verified" || c.status === "attributed");
      // #21.3: conjecture claims are tellable (framed) outside strict mode and
      // count toward the gate; entertainment channels skip the gate entirely.
      const mode = resolveFactualityMode(charter.verificationBar);
      const conjecture = mode === "strict" ? [] : allClaims.filter((c) => c.status === "conjecture");
      const tellable = usable.length + conjecture.length;
      // Facts-gate (build #18, mode-aware since #21.3): don't even mint an idea
      // for an under-researched episode — but "tellable" now includes framed
      // conjecture, and entertainment channels are exempt.
      const minFacts = minFactsToScript(charter.verificationBar);
      if (factsGateApplies(mode) && tellable < minFacts) {
        await db.update(episodes).set({ status: "cut" }).where(eq(episodes.id, episodeId));
        const summary =
          tellable === 0
            ? `Cut "${episode.title}": no claim survived verification (${allClaims.length} extracted).`
            : `Cut "${episode.title}": only ${tellable} tellable fact(s) (${usable.length} verified/attributed, ${conjecture.length} conjecture), need ≥${minFacts} to script (${allClaims.length} extracted).`;
        await db.insert(channelDecisions).values({
          id: ulid(),
          channelId,
          kind: "episode_cut",
          summary,
          detail: {
            episodeId,
            usableClaims: usable.length,
            conjectureClaims: conjecture.length,
            factualityMode: mode,
            minFactsToScript: minFacts,
          },
          actor: "agent",
        });
        return { cut: true as const };
      }
      const brief = await writeEpisodeBrief(ctx, {
        topic: episode.title,
        angle: episode.angle,
        claims: [
          ...usable.map((c) => ({ id: c.id, tier: c.tier as string, text: c.text })),
          // conjecture reaches the brief tagged, so outline points hedge it
          ...conjecture.map((c) => ({ id: c.id, tier: "conjecture", text: c.text })),
        ],
      });
      await db
        .update(episodes)
        .set({ brief: brief as unknown as Record<string, unknown>, status: "briefed" })
        .where(eq(episodes.id, episodeId));
      return { cut: false as const, claims: usable.length };
    });
    if (briefResult.cut) {
      // #23.1 gap-fill: the cut vacated a series slot — ask the planner for a
      // replacement episode so the tentative schedule doesn't silently thin out
      // (episodes always belong to a series; the gapfill fn guards loops).
      await step.sendEvent("gapfill-cut", {
        name: "editorial/gapfill.requested",
        data: { channelId, seriesId: episode.seriesId, episodeId },
      });
      return { episodeId, outcome: "cut" };
    }

    // 7) conservative promotion of clearly-general chunks to channel scope
    await step.run("promote-memory", async () => {
      const { db, providers, costSink } = await getContext();
      const ctx = { db, llm: providers.llm, costSink, channelId };
      const chunks = await db
        .select({ id: memoryChunks.id, content: memoryChunks.content })
        .from(memoryChunks)
        .where(and(eq(memoryChunks.episodeId, episodeId), eq(memoryChunks.scope, "episode")));
      if (chunks.length === 0) return { promoted: 0 };
      const result = await classifyMemoryScope(ctx, {
        chunks: chunks.map((c, i) => ({ index: i, text: c.content })),
      });
      let promoted = 0;
      for (const idx of result.promoteIndexes) {
        const chunk = chunks[idx];
        if (!chunk) continue;
        await db.update(memoryChunks).set({ scope: "channel" }).where(eq(memoryChunks.id, chunk.id));
        promoted++;
      }
      return { promoted };
    });

    // 8) hand off into the production spine: idea (+ auto-greenlight on T2+)
    const handoff = await step.run("queue-idea", async () => {
      const { db } = await getContext();
      const claimIds = await db
        .select({ id: claims.id })
        .from(claims)
        .where(eq(claims.episodeId, episodeId));
      const ideaId = ulid();
      await db.insert(ideas).values({
        id: ideaId,
        channelId,
        title: episode.title,
        angle: episode.angle,
        sourceType: "editorial",
        researchRefs: claimIds.map((c) => c.id),
        status: autonomyTier >= 2 ? "greenlit" : "inbox",
      });
      await db.update(episodes).set({ ideaId, status: "queued" }).where(eq(episodes.id, episodeId));
      if (autonomyTier >= 2) {
        const productionId = ulid();
        await db.insert(productions).values({ id: productionId, ideaId, channelId, status: "greenlit" });
        return { ideaId, productionId };
      }
      return { ideaId, productionId: null };
    });

    // #19: auto-score gated (T0/T1) editorial ideas at handoff so they arrive in
    // the Plan tab already scored — the operator sees a priority signal and can
    // greenlight inline instead of routing through the Ideas page. Best-effort:
    // a scoring failure must never block the research handoff.
    if (handoff.productionId === null && autonomyTier < 2) {
      await step.run("score-idea", async () => {
        const { db, providers, costSink } = await getContext();
        try {
          await scoreIdea(
            { db, llm: providers.llm, costSink, channelId, ideaId: handoff.ideaId },
            handoff.ideaId,
          );
        } catch (err) {
          console.error(`[episode-research] auto-score failed for idea ${handoff.ideaId}:`, err);
        }
      });
    }

    if (handoff.productionId) {
      await step.sendEvent("greenlit", {
        name: "production/greenlit",
        data: { productionId: handoff.productionId, attempt: "0" },
      });
    }

    return { episodeId, outcome: "queued", ideaId: handoff.ideaId };
  },
);
