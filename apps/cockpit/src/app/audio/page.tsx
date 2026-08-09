import { desc } from "drizzle-orm";
import { audioAssets } from "@ytauto/db";
import { audioAttributionLine } from "@ytauto/core";
import { getAppContext } from "@/lib/context";
import { AssetRow, AudioUpload } from "./audio-library-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audio library · YT Auto" };

/**
 * #110: the platform-wide audio library. Operator-supplied music with licence
 * provenance (T.A.S.L.) — any channel pulls from here via set_music_bed
 * (addLibraryAssetId) or the production music panel. An asset without
 * commercialUse true cannot be attached anywhere: a monetised channel is
 * commercial use, so NC/ND/unknown licences are blocked, not warned about.
 */
export default async function AudioLibraryPage() {
  const { db } = await getAppContext();
  const rows = await db.select().from(audioAssets).orderBy(desc(audioAssets.createdAt)).limit(500);

  return (
    <div style={{ padding: "16px 0" }}>
      <h1 style={{ marginBottom: 4 }}>Audio library</h1>
      <p style={{ opacity: 0.7, marginTop: 0, marginBottom: 12 }}>
        Platform-wide music with licence provenance — every channel can pull from here. Upload tracks, record where
        they came from and under what licence; CC BY credits are generated automatically and flow into the video
        description at publish. Tracks without a commercial-safe licence are blocked from beds and productions, not
        just flagged.
      </p>

      <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
        <AudioUpload />
      </div>

      {rows.length === 0 ? (
        <div className="callout" style={{ fontSize: 13.5 }}>
          Nothing in the library yet. Upload files here, or register one from a URL over MCP with
          <code style={{ margin: "0 4px" }}>register_audio_asset</code>(it can enrich title/creator/licence from the
          track&rsquo;s source page).
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => (
            <AssetRow
              key={r.id}
              asset={{
                id: r.id,
                storageKey: r.storageKey,
                title: r.title,
                creator: r.creator,
                creatorUrl: r.creatorUrl,
                sourceUrl: r.sourceUrl,
                licence: r.licence,
                licenceUrl: r.licenceUrl,
                modified: r.modified,
                commercialUse: r.commercialUse,
                durationSec: r.durationSec,
                mood: r.mood,
                notes: r.notes,
                attributionLine: audioAttributionLine(r),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
