"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function Mono({
  children, copyable = false, className,
}: { children: string; copyable?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-xs", className)}>
      <span className="truncate">{children}</span>
      {copyable && (
        <Button
          variant="ghost" size="icon" aria-label="Copy value"
          className="size-5 shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </Button>
      )}
    </span>
  );
}
