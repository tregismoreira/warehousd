"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Boxes, FileText, Info, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ApplyBadge } from "@/components/common/ApplyBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";
import type { CollectionSummary } from "./types";

// Twenty collections in one scrolling stack of field tables was unreadable and unsearchable, and
// it put the same drift banner at the top whatever had drifted. This is the index: one row per
// collection, grouped by what it is, with the state that differs between them — how much data it
// holds here, whether what is deployed still matches the YAML — and a link to the rest.
export function CollectionsList() {
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [env, setEnv] = useState<"dev" | "live">("dev");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        // counts=1: this is the one surface that renders a document count, and counting is a
        // scan per collection. See the route.
        const res = await fetch("/api/admin/collections?counts=1");
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
        const data = await res.json();
        setCollections(data.collections);
        setEnv(data.env);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return collections;
    return collections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.taxonomies.some((t) => t.toLowerCase().includes(q)),
    );
  }, [collections, query]);

  if (loading) return <div className="text-muted-foreground">Loading...</div>;
  if (error) return <div className="text-destructive">Error: {error}</div>;

  const drifted = collections.filter((c) => c.status !== "applied");
  const datasets = matches.filter((c) => c.type !== "file");
  const files = matches.filter((c) => c.type === "file");

  return (
    <div className="space-y-6">
      {drifted.length > 0 && (
        <div className="flex gap-3 rounded-lg border border-pending/30 bg-pending/5 p-4">
          <Info className="size-5 shrink-0 text-pending" />
          <div className="text-sm">
            <p className="font-medium">
              {drifted.length} of {collections.length} collections differ from what is deployed
            </p>
            <p className="mt-1 text-muted-foreground">
              Run <Mono copyable>warehousd apply</Mono> to reconcile. Each collection below says
              where it stands.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search collections"
            placeholder="Search collections"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Document counts are for <Mono>{env}</Mono>. Use the environment switcher to see the other.
        </p>
      </div>

      {matches.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching collections"
          description="Nothing in warehousd.yml matches that. Clear the search to see them all."
        />
      ) : (
        <div className="space-y-8">
          <Group icon={Boxes} title="Datasets" collections={datasets} />
          <Group icon={FileText} title="File collections" collections={files} />
        </div>
      )}

      <div className="text-xs text-muted-foreground italic">
        A field with posture <Mono>deny</Mono> can never be granted to anyone. Change it in{" "}
        <Mono>warehousd.yml</Mono> and re-apply.
      </div>
    </div>
  );
}

function Group({
  icon: Icon,
  title,
  collections,
}: {
  icon: typeof Boxes;
  title: string;
  collections: CollectionSummary[];
}) {
  if (collections.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Icon size={16} className="text-muted-foreground" />
        {title}
        <span className="text-muted-foreground">({collections.length})</span>
      </h2>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Collection</TableHead>
              <TableHead>Taxonomies</TableHead>
              <TableHead>Fields</TableHead>
              <TableHead className="text-right">Documents</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collections.map((c) => (
              <TableRow key={c.name}>
                <TableCell>
                  <Link
                    href={`/admin/collections/${c.name}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {c.name}
                  </Link>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">{c.description}</p>
                </TableCell>
                <TableCell>
                  {c.taxonomies.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {c.taxonomies.map((t) => (
                        <Badge key={t} variant="secondary" className="font-mono text-xs">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{c.fields.length}</TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {/* null is "never applied here", which is not the same fact as zero rows. */}
                  {c.documentCount === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    c.documentCount.toLocaleString()
                  )}
                </TableCell>
                <TableCell>
                  <ApplyBadge status={c.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
