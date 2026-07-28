"use client";
import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Mono } from "@/components/common/Mono";

type ApplyStatus = "not_applied" | "applied" | "drifted";
type Posture = "allow" | "deny";

interface ViewJoin {
  table: string;
  column: string;
  on: string;
}

interface Field {
  name: string;
  type: string | null;
  posture: Posture;
  pk: boolean;
  fk: string | null;
  view_join: ViewJoin | null;
}

interface Collection {
  name: string;
  description: string;
  type: "dataset" | "file";
  taxonomies: string[];
  status: ApplyStatus;
  appliedAt: string | null;
  fields: Field[];
}

function PostureBadge({ posture }: { posture: Posture }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-mono text-xs",
      posture === "allow" ? "text-allow" : "text-deny")}>
      <span aria-hidden>{posture === "allow" ? "✓" : "✗"}</span>
      {posture}
    </Badge>
  );
}

function ApplyBadge({ status }: { status: ApplyStatus }) {
  const map = {
    applied:     { label: "Applied",     dot: "bg-allow" },
    drifted:     { label: "Drifted",     dot: "bg-pending" },
    not_applied: { label: "Not applied", dot: "bg-muted-foreground" },
  } as const;
  return (
    <Badge variant="outline" className="gap-1.5" role="status">
      <span className={cn("size-1.5 rounded-full", map[status].dot)} />
      {map[status].label}
    </Badge>
  );
}

export function CollectionsView() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/admin/collections");
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
        const data = await res.json();
        setCollections(data.collections);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <div className="text-muted-foreground">Loading...</div>;
  if (error) return <div className="text-destructive">Error: {error}</div>;

  const hasDrift = collections.some(c => c.status !== "applied");

  return (
    <div className="space-y-6">
      {hasDrift && (
        <div className="flex gap-3 rounded-lg border border-pending/30 bg-pending/5 p-4">
          <Info className="size-5 shrink-0 text-pending" />
          <div className="text-sm">
            <p className="font-medium">Configuration drift detected</p>
            <p className="mt-1 text-muted-foreground">
              The configuration on disk differs from what is deployed. Run{" "}
              <Mono copyable>warehousd apply</Mono>
              {" "}to reconcile.
            </p>
          </div>
        </div>
      )}

      <div className="text-xs text-muted-foreground italic">
        A field with posture <Mono>deny</Mono> can never be granted to anyone. Change it in{" "}
        <Mono>warehousd.yml</Mono>
        {" "}and re-apply.
      </div>

      <div className="grid gap-6">
        {collections.map(collection => (
          <Card key={collection.name}>
            <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
              <div>
                <CardTitle className="text-base">{collection.name}</CardTitle>
                <p className="mt-2 text-sm text-muted-foreground">{collection.description}</p>
              </div>
              <div className="flex gap-2">
                <Badge variant="secondary" className="font-mono text-xs">
                  {collection.type}
                </Badge>
                <ApplyBadge status={collection.status} />
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Field</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Posture</TableHead>
                    <TableHead>Keys</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {collection.fields.map(field => (
                    <TableRow key={field.name}>
                      <TableCell className="font-mono text-xs">{field.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {field.type ? <Mono>{field.type}</Mono> : "—"}
                      </TableCell>
                      <TableCell>
                        <PostureBadge posture={field.posture} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {field.pk ? "pk" : field.fk ? `fk:${field.fk}` : field.view_join ? `join:${field.view_join.table}.${field.view_join.column}` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
