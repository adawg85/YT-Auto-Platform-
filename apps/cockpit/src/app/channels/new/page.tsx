import Link from "next/link";
import { ChannelWizard } from "./wizard";
import { IconChevronLeft } from "@/components/icons";

export default function NewChannelPage() {
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
      <ChannelWizard />
    </>
  );
}
