import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/context";
import { loadStatusSummary } from "@/lib/status-data";

export const dynamic = "force-dynamic";

/** System-status counts for the topbar strip (task #21). */
export async function GET() {
  const { db } = await getAppContext();
  const summary = await loadStatusSummary(db);
  return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
}
