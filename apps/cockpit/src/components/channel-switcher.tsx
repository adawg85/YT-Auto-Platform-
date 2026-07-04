import Link from "next/link";
import { IconChevronDown } from "./icons";

const GRAD = "linear-gradient(135deg,var(--accent),var(--accent-2))";

// Native <details> dropdown — jump between channels without leaving the page.
export function ChannelSwitcher({
  channels,
  currentId,
}: {
  channels: { id: string; name: string }[];
  currentId: string;
}) {
  const current = channels.find((c) => c.id === currentId);
  return (
    <details className="switcher">
      <summary>
        {current?.name ?? "Switch channel"}
        <IconChevronDown />
      </summary>
      <div className="menu">
        {channels.map((c) => (
          <Link key={c.id} href={`/channels/${c.id}`}>
            <span className="sw" style={{ background: GRAD }} />
            {c.name}
          </Link>
        ))}
      </div>
    </details>
  );
}
