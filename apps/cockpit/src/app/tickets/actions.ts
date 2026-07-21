"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { agentTickets } from "@ytauto/db";
import { getAppContext } from "@/lib/context";

/** Set a ticket's status (operator triage on the Tickets page). */
export async function setTicketStatusAction(ticketId: string, status: "open" | "acknowledged" | "closed") {
  const { db } = await getAppContext();
  await db.update(agentTickets).set({ status }).where(eq(agentTickets.id, ticketId));
  revalidatePath("/tickets");
}
