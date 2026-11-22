// Which support architecture answers (Module 5, Part 4):
//   multi  Copper plus the Refund agent, with handoffs between them (Module 4).
//   single one support agent that does everything, with no handoff.
// Server-side only. The default is multi, the shipped Module 4 behavior.
// Set AGENT_MODE=single|multi, or pass a mode to the evaluation
// (npm run eval -- --agent-mode single).

export const AGENT_MODES = ["single", "multi"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const DEFAULT_AGENT_MODE: AgentMode = "multi";

/** "single" or "multi" (any case, spaces ignored), otherwise undefined. */
export function parseAgentMode(
  value: string | undefined,
): AgentMode | undefined {
  const text = value?.trim().toLowerCase();
  return AGENT_MODES.find((mode) => mode === text);
}

let warned = false;

/**
 * The mode set by AGENT_MODE. Unset means multi; a value that is neither
 * "single" nor "multi" also means multi, with one warning in the terminal so a
 * typo can't silently pick an architecture.
 */
export function agentMode(): AgentMode {
  const raw = process.env.AGENT_MODE;
  if (!raw?.trim()) return DEFAULT_AGENT_MODE;
  const mode = parseAgentMode(raw);
  if (mode) return mode;
  if (!warned) {
    warned = true;
    console.warn(
      `[agent-mode] AGENT_MODE must be "single" or "multi"; using "${DEFAULT_AGENT_MODE}".`,
    );
  }
  return DEFAULT_AGENT_MODE;
}
