"use server";

import { runControl } from "@ytauto/agents";
import { getAppContext, operatorName } from "@/lib/context";

export async function assistantAction(message: string): Promise<string> {
  const { db, providers, costSink } = await getAppContext();
  return runControl(
    { db, llm: providers.llm, costSink, operator: operatorName() },
    message,
  );
}
