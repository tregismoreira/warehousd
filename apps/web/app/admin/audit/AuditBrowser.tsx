"use client";
import { useEffect, useState } from "react";
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
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
export function AuditBrowser(
  { via, onBack, backLabel }: { via?: string; onBack?: () => void; backLabel?: string } = {}
) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [collections, setCollections] = useState<Collection[]>([]);

  const user = searchParams.get("user") ?? "";
  const collection = searchParams.get("collection") ?? "";
  const outcome = searchParams.get("outcome") ?? "";
  const env = searchParams.get("env") ?? "";
  const limit = Math.max(1, Math.min(parseInt(searchParams.get("limit") ?? "50"), 200));
  const offset = Math.max(0, parseInt(searchParams.get("offset") ?? "0"));

  useEffect(() => {
    fetch("/api/admin/collections")
      .then(r => r.json())
      .then(data => setCollections(data.collections))
      .catch(e => console.error("Failed to load collections:", e));
  }, []);

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
      .then(r => {
        if (!r.ok) throw new Error("Failed to fetch audit events");
        return r.json();
      })
      .then(data => {
        setEvents(data.events);
        setTotal(data.total);
        setLoading(false);
      })
      .catch(e => {
        console.error("Failed to load audit events:", e);
        toast.error("Failed to load audit events");
        setLoading(false);
      });
  }, [via, user, collection, outcome, env, limit, offset]);

  function updateParam(key: string, value: string) {
    const qs = new URLSearchParams(searchParams);
    if (value) {
      qs.set(key, value);
    } else {
      qs.delete(key);
    }
    qs.delete("offset");
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
      cell: ({ row }) => <OutcomeBadge outcome={row.original.outcome} reason={row.original.reason} />,
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
        <button onClick={onBack} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft size={16} />{backLabel ?? "Back"}
        </button>
      )}

      <div className="flex flex-wrap gap-4">
        <div className="flex-1 min-w-40">
          <Label htmlFor="filter-outcome" className="block text-xs font-medium mb-1">Outcome</Label>
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
          <Label htmlFor="filter-env" className="block text-xs font-medium mb-1">Env</Label>
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
          <Label htmlFor="filter-user" className="block text-xs font-medium mb-1">User</Label>
          <Input
            id="filter-user"
            placeholder="User ID"
            value={user}
            onChange={(e) => updateParam("user", e.target.value)}
            className="w-full"
          />
        </div>

        <div className="flex-1 min-w-40">
          <Label htmlFor="filter-collection" className="block text-xs font-medium mb-1">Collection</Label>
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
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPrev}
            onClick={goToPreviousPage}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext}
            onClick={goToNextPage}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
