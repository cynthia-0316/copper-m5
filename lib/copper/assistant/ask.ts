"use server";

// The server action the Ask Copper chat calls. The work is in run.ts, which the
// golden-set evaluation runs too; this file only returns what the panel needs.
import {
  startAskCopper,
  type AskCopperRequest,
  type AskCopperResult,
} from "@/lib/copper/assistant/run";

export type {
  AskCopperRequest,
  AskCopperResult,
  ChatMessage,
} from "@/lib/copper/assistant/run";

export async function askCopper(
  request: AskCopperRequest,
): Promise<AskCopperResult> {
  const { progress } = startAskCopper(request);
  return { progress };
}
