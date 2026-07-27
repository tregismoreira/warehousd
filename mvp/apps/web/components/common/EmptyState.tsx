import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon, title, description, action,
}: { icon: LucideIcon; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-4 rounded-full bg-muted p-3">
        <Icon size={24} className="text-muted-foreground" />
      </div>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      <p className="mb-4 max-w-xs text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}
