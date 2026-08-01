"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileText, Tags } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { PageHeader } from "@/components/common/PageHeader";
import { PostureBadge } from "@/components/common/PostureBadge";
import type { BoundVocabulary, CollectionDetail as Detail, FileRow } from "../types";
import { DataBrowser } from "./DataBrowser";

// Master/detail: one route per collection, so a collection is a thing you can link somebody to.
// Everything on this page is scoped to the console's current environment — counts, terms, files
// and data all come from whichever of dev/live the switcher is on.
export function CollectionDetail({ name }: { name: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/collections/${encodeURIComponent(name)}`);
      if (!res.ok)
        throw new Error(res.status === 404 ? "No such collection" : `HTTP ${res.status}`);
      setDetail(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <BackTo>{<div className="text-destructive">Error: {error}</div>}</BackTo>;
  if (!detail) return <BackTo>{<div className="text-muted-foreground">Loading...</div>}</BackTo>;

  return (
    <div>
      <Link
        href="/admin/collections"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} />
        All collections
      </Link>

      <PageHeader
        title={detail.name}
        description={detail.description}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="font-mono text-xs">
              {detail.type}
            </Badge>
            {detail.writable && (
              <Badge variant="secondary" className="font-mono text-xs">
                writable
              </Badge>
            )}
            <Badge variant="outline" className="font-mono text-xs">
              {detail.env}
            </Badge>
            <ApplyBadge status={detail.status} />
          </div>
        }
      />

      <p className="mb-6 text-sm text-muted-foreground">
        {detail.documentCount === null ? (
          <>
            Nothing applied to <Mono>{detail.env}</Mono> yet — run{" "}
            <Mono copyable>warehousd apply</Mono>.
          </>
        ) : (
          <>
            <span className="font-mono">{detail.documentCount.toLocaleString()}</span> documents in{" "}
            <Mono>{detail.env}</Mono>
            {detail.appliedAt && <> · applied {new Date(detail.appliedAt).toLocaleString()}</>}
          </>
        )}
      </p>

      <Tabs defaultValue="fields">
        <TabsList>
          <TabsTrigger value="fields">Fields</TabsTrigger>
          <TabsTrigger value="taxonomies">Taxonomies</TabsTrigger>
          {detail.type === "file" && <TabsTrigger value="files">Files</TabsTrigger>}
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>

        <TabsContent value="fields" className="pt-4">
          <FieldsTab detail={detail} />
        </TabsContent>
        <TabsContent value="taxonomies" className="pt-4">
          <TaxonomiesTab collection={detail.name} taxonomies={detail.taxonomies} />
        </TabsContent>
        {detail.type === "file" && (
          <TabsContent value="files" className="pt-4">
            <FilesTab collection={detail.name} env={detail.env} />
          </TabsContent>
        )}
        <TabsContent value="data" className="pt-4">
          <DataBrowser detail={detail} onGrantChanged={load} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BackTo({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Link
        href="/admin/collections"
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} />
        All collections
      </Link>
      {children}
    </div>
  );
}

function FieldsTab({ detail }: { detail: Detail }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground italic">
        Both axes are always shown. A field with <Mono>read deny</Mono> can never be granted to
        anyone; a field with <Mono>write deny</Mono> can never be proposed against. Change either in{" "}
        <Mono>warehousd.yml</Mono> and re-apply.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Field</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Posture</TableHead>
              <TableHead>Keys</TableHead>
              <TableHead>Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.fields.map((f) => (
              <TableRow key={f.name}>
                <TableCell className="font-mono text-xs">{f.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {f.type ? <Mono>{f.type}</Mono> : "—"}
                </TableCell>
                <TableCell>
                  <PostureBadge posture={f.posture} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {f.pk
                    ? "pk"
                    : f.fk
                      ? `fk:${f.fk}`
                      : f.view_join
                        ? `join:${f.view_join.table}.${f.view_join.column}`
                        : "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {[f.searchable && "searchable", f.nullable && "nullable"]
                    .filter(Boolean)
                    .join(", ") || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function TaxonomiesTab({
  collection,
  taxonomies,
}: {
  collection: string;
  taxonomies: BoundVocabulary[];
}) {
  if (taxonomies.length === 0)
    return (
      <EmptyState
        icon={Tags}
        title="No taxonomies bound"
        description={`${collection} binds no vocabulary, so no grant on it can be scoped to a term.`}
      />
    );

  return (
    <div className="space-y-6">
      {taxonomies.map((v) => (
        <section key={v.field} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{v.label}</h3>
            <Mono className="text-muted-foreground">{v.field}</Mono>
            <Badge variant="secondary" className="font-mono text-xs">
              {v.multiple ? "multiple" : "single"}
            </Badge>
            {/* Where the terms come from decides whether a label can be resolved from the YAML
                at all: a dataset-sourced vocabulary's labels are fields of another collection. */}
            <Badge variant="outline" className="font-mono text-xs">
              {v.source ? `${v.source.collection}.${v.source.slug}` : "warehousd.yml"}
            </Badge>
            {!v.applied && (
              <Badge variant="outline" className="text-xs text-pending">
                not applied
              </Badge>
            )}
          </div>

          {v.terms.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {v.applied
                ? "No terms in this environment yet."
                : "Declared in warehousd.yml but never applied, so it has no terms here yet."}
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
        </section>
      ))}
    </div>
  );
}

function FilesTab({ collection, env }: { collection: string; env: "dev" | "live" }) {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    setState("loading");
    fetch(`/api/admin/collections/${encodeURIComponent(collection)}/files`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        setFiles(data.files);
        setFields(data.fields);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, [collection, env]);

  if (state === "loading") return <div className="text-muted-foreground">Loading...</div>;
  if (state === "error")
    return (
      <EmptyState
        icon={FileText}
        title="File list unavailable"
        description="Nothing is indexed for this collection in this environment yet."
      />
    );
  if (files.length === 0)
    return (
      <EmptyState
        icon={FileText}
        title="No indexed files"
        description={`Nothing has been indexed into ${collection} for ${env}.`}
      />
    );

  // A column appears only when the route returned that field. `path` is posture:deny in the
  // harbor example, so it is absent for anyone whose grant does not name it — and an absent
  // column says that more honestly than a column of blanks would.
  const shows = (f: string) => fields.includes(f);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground italic">
        {files.length} file{files.length === 1 ? "" : "s"} indexed into <Mono>{env}</Mono>. A file
        is chunked into documents; grants and search work on the documents.
        {!shows("path") && " Source paths are posture: deny here, so they are not shown."}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {shows("title") && <TableHead>Title</TableHead>}
              {shows("path") && <TableHead>Path</TableHead>}
              {shows("owner") && <TableHead>Owner</TableHead>}
              {shows("updated_at") && <TableHead>Updated</TableHead>}
              <TableHead className="text-right">Documents</TableHead>
              <TableHead>Checksum</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((f) => (
              <TableRow key={f.id}>
                {shows("title") && (
                  <TableCell className="text-sm font-medium">{f.title ?? "—"}</TableCell>
                )}
                {shows("path") && (
                  <TableCell>
                    <Mono className="text-muted-foreground">{f.path ?? "—"}</Mono>
                  </TableCell>
                )}
                {shows("owner") && (
                  <TableCell className="text-xs text-muted-foreground">{f.owner ?? "—"}</TableCell>
                )}
                {shows("updated_at") && (
                  <TableCell className="text-xs text-muted-foreground">
                    {f.updated_at ? new Date(f.updated_at).toLocaleDateString() : "—"}
                  </TableCell>
                )}
                <TableCell className="text-right font-mono text-xs">{f.documentCount}</TableCell>
                <TableCell>
                  <Mono className="text-muted-foreground">{f.checksum.slice(0, 12)}</Mono>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
