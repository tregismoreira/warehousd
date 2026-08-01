"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Tags } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";

type Vocabulary = {
  slug: string;
  label: string;
  multiple: boolean;
  source: { collection: string; slug: string; label: string } | null;
  applied: boolean;
  collections: string[];
  terms: { slug: string; label: string; documentCount: number }[];
};

// Taxonomies were fully built and entirely invisible: the schema, the tables, the sync and the
// binding loader all existed, and the only place a term ever appeared in the console was as a
// checkbox inside the approval sheet. This is the page that says what a vocabulary *is* — where
// its terms come from, which collections bind it, and how much data each term actually covers.
export function TaxonomiesView() {
  const [vocabularies, setVocabularies] = useState<Vocabulary[]>([]);
  const [env, setEnv] = useState<"dev" | "live">("dev");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/taxonomies")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Failed to fetch: ${r.status}`);
        const data = await r.json();
        setVocabularies(data.vocabularies);
        setEnv(data.env);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Unknown error"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-muted-foreground">Loading...</div>;
  if (error) return <div className="text-destructive">Error: {error}</div>;
  if (vocabularies.length === 0)
    return (
      <EmptyState
        icon={Tags}
        title="No vocabularies"
        description="Declare one under `taxonomies:` in warehousd.yml and bind it to a collection to scope grants by term."
      />
    );

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Document counts are for <Mono>{env}</Mono>, summed across every collection that binds the
        vocabulary. A dataset-sourced vocabulary has different terms in each environment, because
        its terms are documents in another collection.
      </p>

      {vocabularies.map((v) => (
        <Card key={v.slug}>
          <CardHeader className="gap-2 border-b pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{v.label}</CardTitle>
              <Mono className="text-muted-foreground">{v.slug}</Mono>
              <Badge variant="secondary" className="font-mono text-xs">
                {v.multiple ? "multiple" : "single"}
              </Badge>
              {/* A dataset-sourced vocabulary's labels are columns of another collection, which is
                  why they cannot be resolved from the YAML and why this says where to look. */}
              <Badge variant="outline" className="font-mono text-xs">
                {v.source ? `${v.source.collection}.${v.source.slug}` : "warehousd.yml"}
              </Badge>
              {!v.applied && (
                <Badge variant="outline" className="text-xs text-pending">
                  not applied
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {v.collections.length === 0 ? (
                "Bound to no collection — no grant can be scoped to it."
              ) : (
                <>
                  Bound to{" "}
                  {v.collections.map((c, i) => (
                    <span key={c}>
                      {i > 0 && ", "}
                      <Link
                        href={`/admin/collections/${c}`}
                        className="font-mono underline-offset-4 hover:underline"
                      >
                        {c}
                      </Link>
                    </span>
                  ))}
                </>
              )}
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            {v.terms.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {v.applied
                  ? `No terms in ${env}.`
                  : "Declared in warehousd.yml but never applied, so it has no terms yet."}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Term</TableHead>
                      <TableHead>Slug</TableHead>
                      <TableHead className="text-right">Documents</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {v.terms.map((t) => (
                      <TableRow key={t.slug}>
                        <TableCell className="text-sm">{t.label}</TableCell>
                        <TableCell>
                          <Mono className="text-muted-foreground">{t.slug}</Mono>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {t.documentCount.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
