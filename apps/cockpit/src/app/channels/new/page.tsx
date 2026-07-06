import Link from "next/link";
import { ChannelWizard } from "./wizard";

export default function NewChannelPage() {
  return (
    <div>
      <h1>New channel</h1>
      <p className="muted">
        Co-create the charter with the AI — mission, sources, verification bar, identity —
        or use the <Link href="/channels/new/manual">classic form</Link> for a manual channel.
      </p>
      <ChannelWizard />
    </div>
  );
}
