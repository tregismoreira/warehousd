import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// Config always normalizes posture to this canonical {read,write} shape (see
// packages/broker/src/config/schema.ts normalizePosture) — a bare `posture: allow` in YAML
// becomes {read:"allow", write:"deny"} by the time it reaches the API.
export type Posture = { read: "allow" | "deny"; write: "allow" | "deny" };

// Both axes, always.
//
// This used to render the write badge only when write was `allow`, which made "this field is
// write-denied" and "this collection has no write path" look identical — an absent badge. The
// whole point of showing a posture is that a denial is visible, so a denial that renders as
// nothing is the one case it must not have.
export function PostureBadge({ posture }: { posture: Posture }) {
  return (
    <div className="flex gap-1.5">
      <Axis axis="read" value={posture.read} />
      <Axis axis="write" value={posture.write} />
    </div>
  );
}

function Axis({ axis, value }: { axis: "read" | "write"; value: "allow" | "deny" }) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-mono text-xs", value === "allow" ? "text-allow" : "text-deny")}
    >
      <span aria-hidden>{value === "allow" ? "✓" : "✗"}</span>
      {axis} {value}
    </Badge>
  );
}
