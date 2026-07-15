import { NextResponse } from "next/server";
import { getMergedEnv } from "@/lib/context";

/**
 * Media engine diagnostics (operator-only; the middleware gates every route).
 * One request answers the questions we can't from the sandbox:
 *  - is GEMINI_API_KEY actually present (from env OR /account secrets)?
 *  - which image-capable models does THIS key list? (ground truth for the id)
 *  - does a live generateContent against the resolved hero model succeed, and
 *    if not, what is Google's exact error?
 *
 * Hit: /api/diag/media  (add ?test=0 to skip the paid ~$0.13 test generation)
 */
export const dynamic = "force-dynamic";

const GL = "https://generativelanguage.googleapis.com/v1beta";

function mask(v: string | undefined): string | null {
  if (!v) return null;
  return v.length <= 8 ? "set" : `${v.slice(0, 4)}…${v.slice(-2)} (len ${v.length})`;
}

export async function GET(req: Request) {
  const env = await getMergedEnv();
  const key = env.GEMINI_API_KEY;
  const heroModel = env.GEMINI_IMAGE_MODEL_HERO?.trim() || "gemini-3-pro-image";
  const standardModel = env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";
  const runTest = new URL(req.url).searchParams.get("test") !== "0";

  const out: Record<string, unknown> = {
    keys: {
      GEMINI_API_KEY: mask(key),
      DASHSCOPE_API_KEY: mask(env.DASHSCOPE_API_KEY),
      FAL_KEY: mask(env.FAL_KEY),
    },
    resolvedModels: { hero: heroModel, standard: standardModel },
    source: {
      GEMINI_IMAGE_MODEL_HERO_env: process.env.GEMINI_IMAGE_MODEL_HERO ?? null,
      note: "hero/standard above are what media-gemini.ts will actually use",
    },
  };

  if (!key) {
    out.error = "GEMINI_API_KEY is NOT present (neither Render env nor /account secrets decrypted). Every nano-banana call is falling back to another engine.";
    return NextResponse.json(out, { status: 200 });
  }

  // 1) models.list — the definitive list of ids valid for this key
  try {
    const res = await fetch(`${GL}/models?key=${key}&pageSize=1000`);
    if (!res.ok) {
      out.modelsList = { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}` };
    } else {
      const json = (await res.json()) as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
      };
      const names = (json.models ?? []).map((m) => (m.name ?? "").replace(/^models\//, ""));
      out.modelsList = {
        imageModels: names.filter((n) => /image/i.test(n)),
        total: names.length,
      };
    }
  } catch (err) {
    out.modelsList = { error: err instanceof Error ? err.message : String(err) };
  }

  // 2) live hero-model generateContent test (skippable with ?test=0)
  if (runTest) {
    try {
      const res = await fetch(`${GL}/models/${heroModel}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "A simple flat vector illustration of a red circle on white." }] }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: "1:1", ...(/pro-image/i.test(heroModel) ? { imageSize: "2K" } : {}) },
          },
        }),
      });
      const bodyText = await res.text();
      let hasImage = false;
      try {
        const json = JSON.parse(bodyText) as {
          candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] }; finishReason?: string }[];
          promptFeedback?: { blockReason?: string };
        };
        hasImage = !!json.candidates?.[0]?.content?.parts?.some((p) => p.inlineData?.data);
      } catch {
        // non-JSON body
      }
      out.heroTest = {
        model: heroModel,
        httpStatus: res.status,
        ok: res.ok && hasImage,
        returnedImage: hasImage,
        ...(res.ok && hasImage ? {} : { body: bodyText.slice(0, 600) }),
      };
    } catch (err) {
      out.heroTest = { model: heroModel, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return NextResponse.json(out, { status: 200 });
}
