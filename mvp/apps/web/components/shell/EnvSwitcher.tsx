"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function EnvSwitcher({ initial }: { initial: "dev" | "live" }) {
  const [env, setEnv] = useState(initial);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function pick(next: "dev" | "live") {
    if (next === env) return;
    const prev = env;
    setEnv(next); // optimistic
    const res = await fetch("/api/env", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: next }),
    });
    if (!res.ok) { setEnv(prev); toast.error("Could not switch environment"); return; }
    startTransition(() => router.refresh());
  }

  return (
    <div role="group" aria-label="Environment" className="flex rounded-md border p-0.5">
      {(["dev", "live"] as const).map((e) => (
        <button
          key={e}
          onClick={() => pick(e)}
          disabled={pending}
          aria-pressed={env === e}
          className={cn(
            "rounded-sm px-2.5 py-1 font-mono text-xs transition-colors",
            env === e ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
