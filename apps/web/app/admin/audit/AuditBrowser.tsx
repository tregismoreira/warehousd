"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { ArrowLeft, ScrollText } from "lucide-react";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";
import { OutcomeBadge } from "@/components/common/OutcomeBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

type AuditEvent = {
  id: string;
  at: string;
  user_id: string;
  env: "dev" | "live";
  collection: string;
  intent: Record<string, unknown>;
  fields_returned: string[];
  grant_id?: string;
  outcome: "allowed" | "refused";
  reason?: string;
};

type Collection = {
  name: string;
  description?: string;
};

// via/onBack turn this into the scoped "events for one API key" view used from a client's
// detail page — same filters and columns, just a fixed `via` and a back link instead of a title.
//
// defaultEnv is the console's own environment, read from the `wh_env` cookie by the page that
// renders this. Without it the audit page opened on "Any" while every other admin page was
// scoped to one environment — so flipping the switcher changed what you were looking at
// everywhere except the record of what you had looked at.
export function AuditBrowser({
  via,
  onBack,
  backLabel,
  defaultEnv,
}: {
  via?: string;
  onBack?: () => void;
  backLabel?: string;
  defaultEnv?: "dev" | "live";
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [collections, setCollections] = useState<Collection[]>([]);

  const user = searchParams.get("user") ?? "";
  const collection = searchParams.get("collection") ?? "";
  const outcome = searchParams.get("outcome") ?? "";
  // `get` answers "" for a present-but-empty parameter and null for an absent one, and the
  // difference is load-bearing here: absent means "first load, use the console's env", empty
  // means "the reader chose Any". Collapsing them would make Any unreachable.
  const env = searchParams.get("env") ?? defaultEnv ?? "";
  const limit = Math.max(1, Math.min(parseInt(searchParams.get("limit") ?? "50"), 200));
  const offset = Math.max(0, parseInt(searchParams.get("offset") ?? "0"));

  useEffect(() => {
    fetch("/api/admin/collections")
      .then((r) => r.json())
      .then((data) => setCollections(data.collections))
      .catch((e) => console.error("Failed to load collections:", e));
  }, []);

  // The query string this component last asked the router for. See updateParam.
  const currentParams = searchParams.toString();
  const pendingParams = useRef<string | null>(null);
  useEffect(() => {
    pendingParams.current = null;
  }, [currentParams]);

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (via) qs.append("via", via);
    if (user) qs.append("user", user);
    if (collection) qs.append("collection", collection);
    if (outcome) qs.append("outcome", outcome);
    if (env) qs.append("env", env);
    qs.append("limit", String(limit));
    qs.append("offset", String(offset));

    fetch(`/api/audit?${qs}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to fetch audit events");
        return r.json();
      })
      .then((data) => {
        setEvents(data.events);
        setTotal(data.total);
        setLoading(false);
      })
      .catch((e) => {
        console.error("Failed to load audit events:", e);
        toast.error("Failed to load audit events");
        setLoading(false);
      });
  }, [via, user, collection, outcome, env, limit, offset]);

  function updateParam(key: string, value: string) {
    // Build on the last query string this component ASKED for, not on the one the router has
    // finished applying.
    //
    // `router.replace` runs in a transition, so neither `useSearchParams()` nor
    // `window.location.search` has caught up by the time the next event fires. Choosing a
    // collection and then typing in the user box rebuilt the URL from a snapshot that never had
    // the collection in it, and silently dropped that filter — two filters cancelling each other
    // depending on how fast somebody types, on the page whose whole job is answering "who read
    // what". The effect above clears the ref as soon as the router lands on ANY new value, so a
    // Back button (which is also a change to `current`) is not built on a stale intent.
    const qs = new URLSearchParams(pendingParams.current ?? currentParams);
    // An empty value normally means "no filter", which is spelled by dropping the key. `env` is
    // the exception: dropping it would fall back to the console's environment, so choosing "Any"
    // would do nothing. Keep the key, empty.
    if (value || (key === "env" && defaultEnv)) {
      qs.set(key, value);
    } else {
      qs.delete(key);
    }
    qs.delete("offset");
    pendingParams.current = qs.toString();
    router.replace(`?${qs}`);
  }

  function goToPreviousPage() {
    if (offset >= limit) {
      updateParam("offset", String(offset - limit));
    }
  }

  function goToNextPage() {
    if (offset + limit < total) {
      updateParam("offset", String(offset + limit));
    }
  }

  const columns: ColumnDef<AuditEvent, unknown>[] = [
    {
      accessorKey: "at",
      header: "Timestamp",
      cell: ({ row }) => <Mono>{new Date(row.original.at).toLocaleString()}</Mono>,
      size: 200,
    },
    {
      accessorKey: "user_id",
      header: "User",
      cell: ({ row }) => <Mono>{row.original.user_id}</Mono>,
      size: 120,
    },
    {
      accessorKey: "env",
      header: "Env",
      cell: ({ row }) => <Mono>{row.original.env}</Mono>,
      size: 80,
    },
    {
      accessorKey: "collection",
      header: "Collection",
      cell: ({ row }) => row.original.collection,
      size: 150,
    },
    {
      accessorKey: "outcome",
      header: "Outcome",
      cell: ({ row }) => (
        <OutcomeBadge outcome={row.original.outcome} reason={row.original.reason ?? null} />
      ),
      size: 150,
    },
    {
      accessorKey: "fields_returned",
      header: "Fields",
      cell: ({ row }) => {
        const fields = row.original.fields_returned;
        if (!fields || fields.length === 0) return <span className="text-muted-foreground">—</span>;
        return <Mono className="text-muted-foreground">{`[${fields.join(", ")}]`}</Mono>;
      },
      size: 200,
    },
    {
      id: "intent",
      header: "Intent",
      cell: ({ row }) => (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="text-xs">
              view intent
            </Button>
          </PopoverTrigger>
          <PopoverContent side="left" className="w-96 p-0">
            <ScrollArea className="h-96 p-4">
              <pre className="font-mono text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(row.original.intent, null, 2)}
              </pre>
            </ScrollArea>
          </PopoverContent>
        </Popover>
      ),
      size: 100,
    },
  ];

  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <div className="space-y-4">
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
          {backLabel ?? "Back"}
        </button>
      )}

      <div className="flex flex-wrap gap-4">
        <div className="flex-1 min-w-40">
          <Label htmlFor="filter-outcome" className="block text-xs font-medium mb-1">
            Outcome
          </Label>
          <Select value={outcome} onValueChange={(v) => updateParam("outcome", v)}>
            <SelectTrigger id="filter-outcome" className="w-full">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Any</SelectItem>
              <SelectItem value="allowed">Allow</SelectItem>
              <SelectItem value="refused">Deny</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-w-40">
          <Label htmlFor="filter-env" className="block text-xs font-medium mb-1">
            Env
          </Label>
          <Select value={env} onValueChange={(v) => updateParam("env", v)}>
            <SelectTrigger id="filter-env" className="w-full">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Any</SelectItem>
              <SelectItem value="dev">Dev</SelectItem>
              <SelectItem value="live">Live</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-w-40">
          <Label htmlFor="filter-user" className="block text-xs font-medium mb-1">
            User
          </Label>
          <Input
            id="filter-user"
            placeholder="User ID"
            value={user}
            onChange={(e) => updateParam("user", e.target.value)}
            className="w-full"
          />
        </div>

        <div className="flex-1 min-w-40">
          <Label htmlFor="filter-collection" className="block text-xs font-medium mb-1">
            Collection
          </Label>
          <Select value={collection} onValueChange={(v) => updateParam("collection", v)}>
            <SelectTrigger id="filter-collection" className="w-full">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Any</SelectItem>
              {collections.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={events}
        loading={loading}
        empty={
          <EmptyState
            icon={ScrollText}
            title={via ? "No events for this key" : "No matching events"}
            description={
              via
                ? "This API key has not accessed any data yet."
                : "Every broker decision lands here — allowed or refused. Widen the filters to see more."
            }
          />
        }
      />

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {total === 0 ? "No events" : `Showing ${start}–${end} of ${total}`}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!hasPrev} onClick={goToPreviousPage}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={!hasNext} onClick={goToNextPage}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
