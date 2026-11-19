import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// Langfuse setup (Module 5). Server only: the keys never reach the browser.
// Tracing is optional. Without all three LANGFUSE_* variables the app works
// exactly as before and says so once in the terminal.
//
// Langfuse gets its own tracer provider (not the global one), so it never
// mixes with Next.js's own telemetry. Spans are sent in batches, so a turn
// calls `flushTraces()` when it ends: a serverless function may stop soon after.

export const LANGFUSE_VARIABLES = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

export type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
};

/** The Langfuse settings, or the names of the variables that are missing. */
export function langfuseConfig():
  | { config: LangfuseConfig; missing: [] }
  | { config: null; missing: string[] } {
  const value = (name: (typeof LANGFUSE_VARIABLES)[number]) =>
    process.env[name]?.trim() ?? "";
  const missing = LANGFUSE_VARIABLES.filter((name) => !value(name));
  if (missing.length > 0) return { config: null, missing: [...missing] };
  return {
    config: {
      publicKey: value("LANGFUSE_PUBLIC_KEY"),
      secretKey: value("LANGFUSE_SECRET_KEY"),
      baseUrl: value("LANGFUSE_BASE_URL"),
    },
    missing: [],
  };
}

export function isTracingConfigured(): boolean {
  return langfuseConfig().config !== null;
}

type Setup = { provider: NodeTracerProvider; processors: SpanProcessor[] };

let setup: Setup | null | undefined;

function install(processors: SpanProcessor[]): Setup {
  const provider = new NodeTracerProvider({ spanProcessors: processors });
  setLangfuseTracerProvider(provider);
  return { provider, processors };
}

/**
 * Starts tracing the first time it's called. Returns false when tracing is
 * off (missing keys, or Langfuse couldn't be set up); never throws.
 */
export function ensureTracing(): boolean {
  if (setup !== undefined) return setup !== null;
  const { config, missing } = langfuseConfig();
  if (!config) {
    console.warn(
      `[langfuse] tracing is off: set ${missing.join(", ")} in .env.local to see Copper's traces in Langfuse.`,
    );
    setup = null;
    return false;
  }
  try {
    setup = install([
      new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        // Each turn flushes itself, so send spans as soon as they end.
        exportMode: "immediate",
      }),
    ]);
    return true;
  } catch (error) {
    console.warn(
      "[langfuse] tracing is off: setup failed:",
      error instanceof Error ? error.message : String(error),
    );
    setup = null;
    return false;
  }
}

/**
 * Sends everything recorded so far to Langfuse. Returns true when it was
 * sent; false (after a warning in the terminal) when tracing is off or the
 * send failed, which means the trace in Langfuse may be incomplete.
 */
export async function flushTraces(): Promise<boolean> {
  if (!setup) return false;
  try {
    await Promise.all(setup.processors.map((p) => p.forceFlush()));
    return true;
  } catch (error) {
    console.warn(
      "[langfuse] could not send traces; this chat's trace may be incomplete:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/** For tests: record spans with these processors instead of sending them. */
export function setSpanProcessorsForTests(processors: SpanProcessor[]) {
  setup = install(processors);
}

/** For tests: forget the setup so the next call starts again. */
export function resetTracingForTests() {
  setup = undefined;
  setLangfuseTracerProvider(null);
}
