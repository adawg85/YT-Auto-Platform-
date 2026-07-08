import Link from "next/link";
import { inArray } from "drizzle-orm";
import { channels } from "@ytauto/db";
import { getAppContext } from "@/lib/context";
import { ChannelWizard } from "./wizard";
import { IconChevronLeft } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function NewChannelPage() {
  const { db } = await getAppContext();
  // long-form channels a new Shorts channel can be derived from (§6/#17)
  const longFormChannels = await db
    .select({ id: channels.id, name: channels.name, niche: channels.niche })
    .from(channels)
    .where(inArray(channels.contentFormat, ["long", "both"]));

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
      <ChannelWizard longFormChannels={longFormChannels} />
    </>
  );
}
