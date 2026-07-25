import { inngest } from "@ytauto/core";
import { fillThinPrompts, regenerateShotPrompt, swapShotImage } from "@ytauto/agents";
import { getContext } from "../context";

/**
 * Operator-triggered shot work, run DURABLY on the worker (2026-07-25 operator:
 * "if I switch out to an app and come back it says offline… the prompts never
 * got generated or image switched — it's like it requires me to be there for it
 * to exist").
 *
 * These operations used to run inside the cockpit request, so backgrounding the
 * browser tab tore the connection down mid-flight and the work was silently
 * lost. The cockpit now only ENQUEUES this event and returns immediately; the
 * work happens here, survives the browser closing, and Inngest retries it on a
 * transient provider failure. Same shared implementation the MCP tools call
 * synchronously (`@ytauto/agents` shot-ops), so behaviour cannot drift.
 */
export const shotOp = inngest.createFunction(
  {
    id: "production-shot-op",
    name: "Production shot operation (regenerate image / prompts)",
    // one at a time per production: two regenerations racing on the same
    // production would fight over the same assets
    concurrency: { key: "event.data.productionId", limit: 1 },
    retries: 2,
  },
  { event: "production/shot-op.requested" },
  async ({ event, step }) => {
    const { productionId, op, assetId, mode, prompt, engine, characterId, useReference } = event.data;

    return step.run(`shot-op-${op}`, async () => {
      const ctx = await getContext();
      if (op === "fill-prompts") {
        const res = await fillThinPrompts(ctx, productionId);
        return { op, productionId, ...res };
      }
      if (!assetId) throw new Error(`shot-op "${op}" requires an assetId`);
      if (op === "prompt") {
        const res = await regenerateShotPrompt(ctx, productionId, assetId, { persist: true });
        return { op, productionId, assetId, ...res };
      }
      if (op === "image") {
        const res = await swapShotImage(
          ctx,
          productionId,
          assetId,
          (mode as "real" | "standard" | "hero") ?? "standard",
          {
            ...(prompt ? { prompt } : {}),
            ...(engine ? { engine: engine as "qwen" | "seedream" | "nano-banana" } : {}),
            ...(characterId ? { characterId } : {}),
            ...(useReference === "1" ? { useReference: true } : {}),
          },
        );
        return { op, productionId, assetId, ...res };
      }
      throw new Error(`Unknown shot op "${op}"`);
    });
  },
);
