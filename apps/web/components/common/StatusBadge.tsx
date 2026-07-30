import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const CONFIG = {
  pending: { label: "Pending", dot: "bg-pending", variant: "outline" as const },
  approved: { label: "Approved", dot: "bg-allow", variant: "outline" as const },
  denied: { label: "Denied", dot: "bg-deny", variant: "outline" as const },
  revoked: { label: "Revoked", dot: "bg-deny", variant: "outline" as const },
  expired: { label: "Expired", dot: "bg-muted-foreground", variant: "outline" as const },
};

export type GrantStatus = keyof typeof CONFIG;

export function StatusBadge({ status }: { status: GrantStatus }) {
  const c = CONFIG[status];
  return (
    <Badge variant={c.variant} className="gap-1.5" role="status">
      <span className={cn("size-1.5 rounded-full", c.dot)} />
      {c.label}
    </Badge>
  );
}
