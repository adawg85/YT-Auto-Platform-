import Link from "next/link";
import { inArray } from "drizzle-orm";
import { channels } from "@ytauto/db";
import type { VoiceOption } from "@ytauto/providers";
import { PERSONA_ARCHETYPE_LIBRARY } from "@ytauto/core";
import { getAppContext, getMergedEnv } from "@/lib/context";
import { ChannelWizard } from "./wizard";
import { IconChevronLeft } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function NewChannelPage({
  searchParams,
}: {
  searchParams?: Promise<{ niche?: string; intent?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const { db, providers } = await getAppContext();
  // long-form channels a new Shorts channel can be derived from (§6/#17)
  const longFormChannels = await db
    .select({ id: channels.id, name: channels.name, niche: channels.niche })
    .from(channels)
    .where(inArray(channels.contentFormat, ["long", "both"]));
  // TTS voice library for the wizard's voice picker (best-effort — a provider
  // hiccup must not break channel creation; the picker just hides).
  let voices: VoiceOption[] = [];
  try {
    voices = await providers.voice.listVoices();
  } catch {
    voices = [];
  }
  // archetype blurbs for chip hover hints (core stays server-side — its barrel
  // pulls node:crypto, so pass the strings down instead of importing in the client)
  const personaBlurbs = Object.fromEntries(
    Object.entries(PERSONA_ARCHETYPE_LIBRARY).map(([key, seed]) => [key, seed.blurb]),
  );
  // Nano Banana art-engine toggle: only a boolean crosses to the client, never
  // the key itself.
  const nanoBananaReady = Boolean((await getMergedEnv()).GEMINI_API_KEY);

  return (
    <>
      <Link href="/channels" className="backlink">
        <IconChevronLeft /> Channels
      </Link>
      <div className="page-head">
        <div>
          <h1 className="page-title">New channel</h1>
          <p className="page-sub">
            Co-create the charter with the AI — mission, sources, verification bar, identity — or use the{" "}
            <Link href="/channels/new/manual" style={{ color: "var(--accent-ink)", fontWeight: 600 }}>
              classic form
            </Link>{" "}
            for a manual channel.
          </p>
        </div>
      </div>
      <ChannelWizard
        longFormChannels={longFormChannels}
        voices={voices}
        personaBlurbs={personaBlurbs}
        nanoBananaReady={nanoBananaReady}
        initialFields={
          params.niche || params.intent
            ? { ...(params.niche ? { niche: params.niche } : {}), ...(params.intent ? { intent: params.intent } : {}) }
            : undefined
        }
      />
    </>
  );
}
