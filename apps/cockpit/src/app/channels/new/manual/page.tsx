import { createChannelAction } from "../../actions";
import { ChannelForm } from "../../channel-form";

/** The pre-wizard flat form — creates a manual channel with no charter. */
export default function NewChannelManualPage() {
  return (
    <div>
      <h1>New channel (manual)</h1>
      <p className="muted">
        No charter, no editorial engine — the channel runs on manual/agent ideation only.
      </p>
      <ChannelForm action={createChannelAction} submitLabel="Create channel" />
    </div>
  );
}
