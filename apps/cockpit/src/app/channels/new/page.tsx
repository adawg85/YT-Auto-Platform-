import Link from "next/link";
import { createChannelAction } from "../actions";
import { ChannelForm } from "../channel-form";
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
          <p className="page-sub">Set the channel basics and its DNA — you can change everything later.</p>
        </div>
      </div>
      <ChannelForm action={createChannelAction} submitLabel="Create channel" />
    </>
  );
}
