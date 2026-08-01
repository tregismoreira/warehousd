import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { ApplyStatus } from "@/lib/apply-status";

const MAP = {
  applied: { label: "Applied", dot: "bg-allow" },
  drifted: { label: "Drifted", dot: "bg-pending" },
  not_applied: { label: "Not applied", dot: "bg-muted-foreground" },
} as const;

// Where the configuration on disk stands against what `warehousd apply` last deployed. Three
// outcomes, no fourth — see lib/apply-status.ts.
export function ApplyBadge({ status }: { status: ApplyStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5" role="status">
      <span className={cn("size-1.5 rounded-full", MAP[status].dot)} />
      {MAP[status].label}
    </Badge>
  );
}
