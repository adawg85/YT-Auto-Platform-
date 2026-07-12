import { eq } from "drizzle-orm";
import { evalResults, evalRuns, ulid } from "@ytauto/db";
import { EVAL_CHANNEL_ID, inngest, type CostSink } from "@ytauto/core";
import { createEvalLLM } from "@ytauto/providers";
import { GOLDEN_SET, measureScript, runEvalChain } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Golden-set eval harness (#21.2.5 / PROMPT-AUDIT §6): run every fixture
 * through the script chain once per candidate model, measure with fixed
 * instruments (factuality proof + judge on the BASE router, deterministic
 * AI-tell metrics in code), and persist per-(fixture, model) rows the
 * /account Evals tab aggregates. Each cell is its own memoized step, so a
 * crashed run resumes without re-spending completed cells. Spend lands under
 * the "eval-harness" pseudo-channel in cost_records.
 */
export const evalHarness = inngest.createFunction(
  { id: "eval-harness", concurrency: 1, retries: 1 },
  { event: "eval/run.requested" },
  async ({ event, step }) => {
    const runId = event.data.runId;

    const run = await step.run("load-run", async () => {
      const { db } = await getContext();
      const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
      return row ?? null;
    });
    if (!run) return { outcome: "missing-run", runId };

    let errors = 0;
    for (const modelRef of run.models) {
      for (const fixture of GOLDEN_SET) {
        const ok = await step.run(`eval-${modelRef}-${fixture.id}`, async () => {
          const { db, env, costSink } = await getContext();
          try {
            // Candidate chain: draft+humanize on the model under test, its
            // spend captured separately from the fixed instruments'.
            const captured = { total: 0 };
            const capturingSink: CostSink = {
              async record(entry) {
                captured.total += entry.costUsd;
                await costSink.record(entry);
              },
            };
            const candidateCtx = {
              db,
              llm: createEvalLLM(env, modelRef),
              costSink: capturingSink,
              channelId: EVAL_CHANNEL_ID,
            };
            const t0 = Date.now();
            const script = await runEvalChain(candidateCtx, fixture);
            const durationMs = Date.now() - t0;

            // Fixed instruments on the base router (never the candidate).
            const { providers } = await getContext();
            const baseCtx = {
              db,
              llm: providers.llm,
              costSink,
              channelId: EVAL_CHANNEL_ID,
            };
            const { judge, metrics } = await measureScript(baseCtx, {
              fixture,
              script,
              modelRef,
              costUsd: captured.total,
              durationMs,
            });

            await db
              .insert(evalResults)
              .values({
                id: ulid(),
                runId,
                fixtureId: fixture.id,
                modelRef,
                status: "ok",
                script: { hookText: script.hookText, fullText: script.fullText },
                judge,
                metrics: metrics as unknown as Record<string, number>,
              })
              .onConflictDoNothing();
            return true;
          } catch (e) {
            await db
              .insert(evalResults)
              .values({
                id: ulid(),
                runId,
                fixtureId: fixture.id,
                modelRef,
                status: "error",
                error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
              })
              .onConflictDoNothing();
            return false;
          }
        });
        if (!ok) errors++;
      }
    }

    await step.run("conclude", async () => {
      const { db } = await getContext();
      const total = run.models.length * GOLDEN_SET.length;
      await db
        .update(evalRuns)
        .set({
          status: errors === total ? "failed" : "complete",
          error: errors ? `${errors}/${total} cells errored` : null,
          concludedAt: new Date(),
        })
        .where(eq(evalRuns.id, runId));
    });

    return { outcome: "complete", runId, cells: run.models.length * GOLDEN_SET.length, errors };
  },
);
