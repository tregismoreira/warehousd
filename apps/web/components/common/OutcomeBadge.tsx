import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function OutcomeBadge({
  outcome,
  reason,
}: {
  outcome: "allowed" | "refused";
  reason?: string | null;
}) {
  const allowed = outcome === "allowed";
  return (
    <Badge
      variant="outline"
      role="status"
      className={cn("gap-1.5 font-mono text-xs", allowed ? "text-allow" : "text-deny")}
    >
      <span aria-hidden>{allowed ? "✓" : "✗"}</span>
      {allowed ? "allow" : "deny"}
      {!allowed && reason ? <span className="text-muted-foreground">· {reason}</span> : null}
    </Badge>
  );
}
