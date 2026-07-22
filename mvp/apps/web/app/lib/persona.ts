// POC-ONLY, replaced by OAuth in MVP. This file is the entire auth stub.
// A dropdown selects the acting user; a toggle selects env. BrokerContext is built directly.
import type { BrokerContext } from "@warehousd/broker";

export const PERSONAS = [
  { id: "ana",    label: "Ana (admin)" },
  { id: "marcus", label: "Marcus (manager)" },
  { id: "mia",  label: "Mia (member)" },
] as const;
export type PersonaId = (typeof PERSONAS)[number]["id"];

export function contextFor(persona: PersonaId, env: "dev" | "live"): BrokerContext {
  return { userId: persona, env }; // no token, no verification — POC only
}
