// The chat console is the Phase 0 demo bench, not a governed product surface. It ships
// in dev and in explicit demo mode only — a deployed production instance must not expose
// an LLM-driven query surface that nothing in §8 asks for.
export function consoleEnabled(env: { NODE_ENV?: string; WAREHOUSD_DEMO?: string }): boolean {
  if (env.NODE_ENV !== "production") return true;
  return env.WAREHOUSD_DEMO === "true";
}
