import { createChannelAction } from "../actions";
import { ChannelForm } from "../channel-form";

export default function NewChannelPage() {
  return (
    <div>
      <h1>New channel</h1>
      <ChannelForm action={createChannelAction} submitLabel="Create channel" />
    </div>
  );
}
