// npm run public-trace
// Runs one real refund conversation through Ask Copper (a customer asks for a
// refund over the auto-refund limit; Copper hands it to the Refund agent; the
// app holds it for a supervisor) and records it in Langfuse as a PUBLIC trace:
// anyone with the link can view it. It is made to be shown, so it carries only
// this fictional conversation. Prints the trace link.
import { startAskCopper } from "@/lib/copper/assistant/run";
import { isAiConfigured } from "@/lib/ai/call";
import { ensureTracing, langfuseConfig } from "@/lib/ai/langfuse";
import { projectId } from "@/evals/langfuse";

async function main() {
  if (!isAiConfigured())
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
  if (!ensureTracing()) throw new Error("Langfuse is not configured");
  const run = startAskCopper(
    {
      messages: [
        {
          role: "user",
          content: "I'd like a refund for my Copper Home, order #1004.",
        },
      ],
      useTools: true,
      desk: { limitUsd: 50, refunds: [] },
      sessionId: `public-demo-${crypto.randomUUID()}`,
    },
    {
      agentMode: "multi",
      publicTrace: true,
      environment: "demo",
      tags: ["public-demo", "refund"],
      metadata: {
        purpose: "In Class Example 5: a refund conversation, shared publicly",
      },
    },
  );
  const outcome = await run.finished;
  console.log(
    "status:",
    outcome.progress.status,
    "| agent that answered:",
    outcome.progress.agent,
  );
  console.log(
    "tools:",
    outcome.progress.steps
      .flatMap((s) =>
        s.type === "tool"
          ? [s.name]
          : s.type === "handoff"
            ? [`handoff ${s.from}->${s.to}`]
            : [],
      )
      .join(", "),
  );
  console.log("reply:", outcome.progress.reply);
  console.log("trace sent to Langfuse:", outcome.traceSent);
  const base = langfuseConfig().config?.baseUrl.replace(/\/$/, "");
  console.log(`trace id: ${run.traceId}`);
  console.log(
    `url: ${base}/project/${await projectId()}/traces/${run.traceId}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
