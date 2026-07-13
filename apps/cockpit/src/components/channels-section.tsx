"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ChannelCard } from "@/lib/overview";
import { channelStatusLabel } from "@/lib/format";
import { Segmented } from "@/components/ui/segmented";
import { Sparkline } from "@/components/charts";
import { IconPlay, IconChevronRight } from "@/components/icons";

const GRAD = "linear-gradient(135deg,var(--accent),var(--accent-2))";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.0+$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 100) / 10 + "K";
  return String(n);
}

type View = "cards" | "table";

/**
 * The Overview "Channels" section with a Cards/Table view toggle. The choice
 * persists in localStorage. Cards = the rich summary tiles; Table = a dense,
 * sortable-feeling grid for scanning many channels at once.
 */
export function ChannelsSection({ cards }: { cards: ChannelCard[] }) {
  const [view, setView] = useState<View>("cards");

  useEffect(() => {
    const v = localStorage.getItem("chanView");
    if (v === "cards" || v === "table") setView(v);
  }, []);

  function change(v: View) {
    setView(v);
    localStorage.setItem("chanView", v);
  }

  return (
    <>
      <div className="page-head" style={{ margin: "22px 0 0", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Channels</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
          <Segmented<View>
            value={view}
            onChange={change}
            options={[
              { value: "cards", label: "Cards" },
              { value: "table", label: "Table" },
            ]}
          />
          <Link href="/channels" className="link-more">
            See all <IconChevronRight />
          </Link>
        </div>
      </div>
      {view === "cards" ? (
        <div className="chan-grid" style={{ marginTop: 14 }}>
          {cards.map((c) => (
            <ChannelCardTile key={c.id} c={c} />
          ))}
        </div>
      ) : (
        <ChannelTable cards={cards} />
      )}
    </>
  );
}

function Avatar({ c, size }: { c: ChannelCard; size: number }) {
  return (
    <span
      className="thumb"
      style={{ width: size, height: size, background: c.avatarKey ? "var(--surface-2)" : GRAD, overflow: "hidden" }}
    >
      {c.avatarKey ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/media/${c.avatarKey}`}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <IconPlay className="" />
      )}
    </span>
  );
}

function ChannelCardTile({ c }: { c: ChannelCard }) {
  return (
    <Link href={`/channels/${c.id}`} className="chan">
      <div className="ch-top">
        <Avatar c={c} size={40} />
        <div style={{ minWidth: 0 }}>
          <div className="ch-name">{c.name}</div>
          <div className="ch-niche">{c.niche}</div>
        </div>
      </div>
      <div style={{ padding: "0 15px 6px" }}>
        <Sparkline id={`sp-${c.id}`} data={c.spark} w={250} h={34} />
      </div>
      <div className="ch-meta">
        <div className="m">
          <div className="mv">{fmtNum(c.views30)}</div>
          <div className="ml">views 30d</div>
        </div>
        <div className="m">
          <div className="mv">{c.retention != null ? `${Math.round(c.retention)}%` : "—"}</div>
          <div className="ml">retention</div>
        </div>
        <div className="m">
          <div className="mv">{c.published7}</div>
          <div className="ml">posted 7d</div>
        </div>
      </div>
      <div className="ch-substats">
        <span>
          <b>{c.totalPublished}</b> published
        </span>
        <span>
          <b>{c.scheduled}</b> scheduled
        </span>
        <span>
          <b>{c.inPipeline}</b> in pipeline
        </span>
      </div>
      <div className="ch-foot">
        <span className="chip">{`T${c.tier}`}</span>
        <span className={`chip ${c.status === "active" ? "good" : "warn"}`}>
          <span className="d" />
          {channelStatusLabel(c.status)}
        </span>
        <span className="num" style={{ fontSize: 12, color: "var(--muted)", marginLeft: "auto" }}>
          ${c.costWeek.toFixed(2)}/wk
        </span>
      </div>
    </Link>
  );
}

function ChannelTable({ cards }: { cards: ChannelCard[] }) {
  const router = useRouter();
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-body flush">
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Tier</th>
                <th>Status</th>
                <th className="r">Views 30d</th>
                <th className="r">Retention</th>
                <th className="r">Published</th>
                <th className="r">Scheduled</th>
                <th className="r">In pipeline</th>
                <th className="r">$/wk</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => router.push(`/channels/${c.id}`)}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <Avatar c={c} size={30} />
                      <span style={{ minWidth: 0 }}>
                        <Link
                          href={`/channels/${c.id}`}
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontWeight: 600, display: "block" }}
                        >
                          {c.name}
                        </Link>
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          {c.niche}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="chip">{`T${c.tier}`}</span>
                  </td>
                  <td>
                    <span className={`chip ${c.status === "active" ? "good" : "warn"}`}>
                      <span className="d" />
                      {channelStatusLabel(c.status)}
                    </span>
                  </td>
                  <td className="r">
                    <span className="num">{fmtNum(c.views30)}</span>
                  </td>
                  <td className="r">
                    <span className="num">{c.retention != null ? `${Math.round(c.retention)}%` : "—"}</span>
                  </td>
                  <td className="r">
                    <span className="num">{c.totalPublished}</span>
                  </td>
                  <td className="r">
                    <span className="num">{c.scheduled}</span>
                  </td>
                  <td className="r">
                    <span className="num">{c.inPipeline}</span>
                  </td>
                  <td className="r">
                    <span className="num">${c.costWeek.toFixed(2)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
