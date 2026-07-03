"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { alerts } from "@ytauto/db";
import { inngest } from "@ytauto/core";
import { getAppContext } from "@/lib/context";

export async function ackAlertAction(alertId: string) {
  const { db } = await getAppContext();
  await db
    .update(alerts)
    .set({ status: "acked", ackedAt: new Date() })
    .where(eq(alerts.id, alertId));
  revalidatePath("/alerts");
}

/** Kick the ingest function outside its 6-hourly cron. */
export async function runIngestNowAction() {
  await inngest.send({ name: "analytics/ingest.requested", data: {} });
  revalidatePath("/alerts");
}
