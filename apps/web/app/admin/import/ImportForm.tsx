"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Upload, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mono } from "@/components/common/Mono";
import { requestJson } from "@/lib/client-api";
// The subpath, not the package barrel. This is a client component, and `@warehousd/broker`'s
// index re-exports `db/pools.ts` — so the barrel pulls `pg` into the browser bundle and the build
// fails on `dns`, `fs`, `net` and `tls`. `import-report` is the pure rendering half and nothing
// else. See packages/broker/src/import/report.ts.
import { reportImportSummary, type ImportErrorSummary } from "@warehousd/broker/import-report";

interface ViewJoin {
  table: string;
  column: string;
  on: string;
}

interface Collection {
  name: string;
  description: string;
  type: string;
  fields: Array<{
    name: string;
    type: string | null;
    posture: string;
    pk: boolean;
    fk: string | null;
    view_join: ViewJoin | null;
    relation: { collection: string; on: string; fields: string[] } | null;
    nullable: boolean;
  }>;
}

interface ImportError {
  row: number;
  column: string;
  reason: string;
}

type Mode = "append" | "upsert" | "delete";

// What each mode does, in the admin's terms rather than the storage layer's. All three append
// revisions; only `append` refuses to touch a document that already exists.
const MODES: { value: Mode; label: string; blurb: string; columns: string }[] = [
  {
    value: "append",
    label: "Append — add new documents",
    blurb:
      "Adds documents. A row whose primary key is already present is refused rather than overwriting it.",
    columns: "Every required column must be present.",
  },
  {
    value: "upsert",
    label: "Upsert — add or revise",
    blurb:
      "Revises documents that exist and adds the ones that do not. Columns your file omits are carried forward unchanged.",
    columns:
      "The primary key must be present. Any other columns are optional — only the ones you include are changed.",
  },
  {
    value: "delete",
    label: "Delete — retire documents",
    blurb:
      "Marks documents deleted. They stop appearing in queries; the revision history is kept and nothing is erased.",
    columns: "Only the primary key is needed. Other columns are ignored.",
  },
];

type State = "pick" | "map" | "confirm" | "result";

// What the mapping step holds: the file's headers, the collection's fields, and header → field.
type MapInfo = {
  headers: string[];
  fields: { name: string; type: string | null; nullable: boolean }[];
  configured: Record<string, string>;
  proposed: Record<string, string>;
  unmatchedHeaders: string[];
  missingRequired: string[];
};

// "4 added, 96 revised" rather than one number that hides which is which. A count of zero is
// left out entirely: "0 deleted" on an upsert is noise.
function summarise(r: { inserted?: number; updated?: number; deleted?: number }): string {
  const parts = [
    [r.inserted ?? 0, "added"],
    [r.updated ?? 0, "revised"],
    [r.deleted ?? 0, "deleted"],
  ].filter(([n]) => (n as number) > 0);
  if (!parts.length) return "Nothing to do — the file matched no changes";
  return parts.map(([n, verb]) => `${n} ${verb as string}`).join(", ");
}

type ImportResponse = {
  ok: boolean;
  mode?: Mode;
  dryRun?: boolean;
  imported?: number;
  inserted?: number;
  updated?: number;
  deleted?: number;
  columns?: string[];
  error?: string;
  errors?: ImportError[];
  // The grouped view. Built by the broker so this panel and `warehousd import validate` count
  // and word a failure identically — see packages/broker/src/import/report.ts.
  summary?: ImportErrorSummary;
};

// Grouped by (column, reason) with complete counts, not a list of the first fifty row numbers.
// Fifty row numbers out of ten thousand is not a diagnosis — "hire_date, invalid date, 97 rows"
// is. The grouping and the wording come from the broker, so this panel and the CLI's
// `import validate` report cannot drift; all that is decided here is the markup.
function ImportErrorPanel({ summary }: { summary: ImportErrorSummary }) {
  const report = reportImportSummary(summary);
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-deny">Nothing was imported. {report.headline}</p>
      <div className="overflow-auto rounded border border-deny/20 bg-card">
        <table className="w-full text-xs">
          <thead className="border-b border-deny/20 text-left text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">Column</th>
              <th className="p-2 font-medium">Problem</th>
              <th className="p-2 font-medium">Extent</th>
              <th className="p-2 font-medium">First</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((l, i) => (
              <tr key={i} className="border-b border-border/40 last:border-0">
                <td className="p-2 font-mono">{l.column ?? "—"}</td>
                <td className="p-2 text-deny">
                  {l.label}
                  {l.hint && <span className="block text-muted-foreground">→ {l.hint}</span>}
                </td>
                <td className="p-2 whitespace-nowrap">{l.extent}</td>
                <td className="p-2 whitespace-nowrap text-muted-foreground">
                  {l.firstRow === null ? "—" : `row ${l.firstRow}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.footer && <p className="text-xs text-muted-foreground">{report.footer}</p>}
    </div>
  );
}

export function ImportForm() {
  const [state, setState] = useState<State>("pick");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCollection, setSelectedCollection] = useState("");
  const [format, setFormat] = useState("csv");
  const [mode, setMode] = useState<Mode>("append");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  // `error` is the route's refusal field, matching the rest of /api. The per-row entries in
  // `errors[]` keep their own `reason` — that is a different thing from why the request failed.
  const [result, setResult] = useState<ImportResponse | null>(null);
  // The dry run's answer, shown in the confirm dialog. An upsert against real data is the one
  // import where "how many of these are new?" is the question you most want answered BEFORE
  // pressing the button, and the preview runs the real statements to answer it.
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  // The mapping step, between "pick a file" and "preview". A real spreadsheet's headers do not
  // match field names — `Base Salary (USD)` against `base_salary` — and until this existed the
  // only remedy was editing the source file.
  const [mapInfo, setMapInfo] = useState<MapInfo | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // The config patch to paste. Rendered, never written: warehousd.yml is governed in git and
  // `warehousd apply` is the only thing that commits it.
  const [proposalYaml, setProposalYaml] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    const loadCollections = async () => {
      const res = await requestJson<{ collections: Collection[] }>("/api/admin/collections");
      if (!res.ok) toast.error(`Failed to load collections: ${res.error}`);
      else setCollections(res.data.collections.filter((c) => c.type !== "file"));
      setLoading(false);
    };
    void loadCollections();
  }, []);

  const currentCollection = collections.find((c) => c.name === selectedCollection);
  const currentMode = MODES.find((m) => m.value === mode)!;
  const pkField = currentCollection?.fields.find((f) => f.pk)?.name ?? null;

  function importForm(dryRun: boolean, extra: Record<string, string> = {}): FormData | null {
    if (!file || !selectedCollection) {
      toast.error("Please select a collection and file");
      return null;
    }
    const fd = new FormData();
    fd.set("collection", selectedCollection);
    fd.set("format", format);
    fd.set("mode", mode);
    if (dryRun) fd.set("dryRun", "1");
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fd.set("file", file);
    return fd;
  }

  /**
   * Post the import and consume the NDJSON progress stream.
   *
   * A long import was one `fetch` and an `uploading` boolean — a frozen button for ten thousand
   * rows, with no way to tell work from a hang. The progress objects are the broker's own
   * `ImportProgress`, the same ones `warehousd import run` renders.
   */
  async function post(dryRun: boolean): Promise<ImportResponse | null> {
    const fd = importForm(dryRun, { stream: "1" });
    if (!fd) return null;
    setProgress(null);
    const res = await fetch("/api/admin/import", { method: "POST", body: fd });
    // A refusal before the stream opened — a bad format, no file — is still plain JSON.
    if (!res.body || !res.headers.get("content-type")?.includes("ndjson"))
      return (await res.json()) as ImportResponse;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: ImportResponse | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as {
          progress?: { done: number; total: number };
          result?: ImportResponse;
        };
        if (msg.progress) setProgress(msg.progress);
        if (msg.result) final = msg.result;
      }
    }
    setProgress(null);
    return final;
  }

  /** Ask the server which field each header lands on, then let the admin correct it. */
  async function handleMap() {
    const fd = importForm(false);
    if (!fd) return;
    setUploading(true);
    try {
      const res = await fetch("/api/admin/import/map", { method: "POST", body: fd });
      const body = (await res.json()) as ({ ok: true } & MapInfo) | { ok: false; error: string };
      if (!body.ok) {
        toast.error(`Could not read the file: ${body.error}`);
        return;
      }
      setMapInfo(body);
      // Start from what the config already says, then the inference for the rest — a header the
      // config maps is a decision somebody made, and a guess must not propose undoing it.
      const start: Record<string, string> = {};
      for (const h of body.headers)
        start[h] =
          body.configured[h] ??
          body.proposed[h] ??
          (body.fields.some((f) => f.name === h) ? h : "");
      setMapping(start);
      setProposalYaml(null);
      setState("map");
    } catch (e) {
      toast.error(`Could not read the file: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

  /** Render the mapping as a config patch to paste. It is never written from here. */
  async function handleSaveMapping() {
    const res = await fetch("/api/admin/import/map", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: selectedCollection, columns: mapping }),
    });
    const body = (await res.json()) as { ok: boolean; yaml?: string; error?: string };
    if (!body.ok) {
      toast.error(`Could not build the patch: ${body.error}`);
      return;
    }
    setProposalYaml(body.yaml ?? "");
  }

  // Preview first, then confirm. A dry run that fails validation goes straight to the result
  // panel: there is nothing to confirm, and the per-row errors are what the admin needs to see.
  async function handlePreview() {
    setUploading(true);
    try {
      const body = await post(true);
      if (!body) return;
      if (!body.ok) {
        setResult(body);
        setState("result");
        return;
      }
      setPreview(body);
      setState("confirm");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Preview failed: ${msg}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleUpload() {
    setUploading(true);
    try {
      const body = await post(false);
      if (!body) return;
      setResult(body);
      if (body.ok) toast.success(summarise(body));
      setState("result");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Import failed: ${msg}`);
    } finally {
      setUploading(false);
    }
  }

  if (state === "map" && mapInfo) {
    const unmapped = mapInfo.headers.filter((h) => !mapping[h]);
    return (
      <Card>
        <CardHeader>
          <CardTitle>Map the columns</CardTitle>
          <CardDescription>
            Which field each header in your file lands on. A header left unmapped will be refused as{" "}
            <Mono>unknown_column</Mono>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-auto rounded border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2 font-medium">Header in your file</th>
                  <th className="p-2 font-medium">Field on {selectedCollection}</th>
                </tr>
              </thead>
              <tbody>
                {mapInfo.headers.map((h) => (
                  <tr key={h} className="border-b last:border-0">
                    <td className="p-2 font-mono text-xs">{h}</td>
                    <td className="p-2">
                      <Select
                        value={mapping[h] || "__none__"}
                        onValueChange={(v) =>
                          setMapping((m) => ({ ...m, [h]: v === "__none__" ? "" : v }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— not imported —</SelectItem>
                          {mapInfo.fields.map((f) => (
                            <SelectItem key={f.name} value={f.name}>
                              {f.name}
                              {f.type ? ` · ${f.type}` : ""}
                              {f.nullable ? "" : " · required"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {unmapped.length > 0 && (
            <p className="text-xs text-deny">
              {unmapped.length} header(s) are not mapped and will be refused. Map them, or remove
              the columns from the file.
            </p>
          )}
          {mapInfo.missingRequired.length > 0 && mode === "append" && (
            <p className="text-xs text-deny">
              No column for required field(s): {mapInfo.missingRequired.join(", ")}. An append will
              refuse the file.
            </p>
          )}

          {proposalYaml !== null && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Paste this into <Mono>warehousd.yml</Mono> and run <Mono>warehousd apply</Mono>.
                Nothing has been written — the config is governed in git, and this console composes
                the patch rather than committing it.
              </p>
              <pre className="overflow-auto rounded border bg-muted p-3 font-mono text-xs">
                {proposalYaml || "# every header already matches a field — no mapping needed"}
              </pre>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setState("pick")}>
              Back
            </Button>
            <Button variant="outline" onClick={() => void handleSaveMapping()}>
              Save this mapping
            </Button>
            <Button
              onClick={() => void handlePreview()}
              disabled={uploading || unmapped.length > 0}
              className="ml-auto"
            >
              <Upload size={16} className="mr-2" />
              {uploading ? "Checking..." : "Preview import"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (state === "result" && result) {
    return (
      <div className="space-y-4">
        {result.ok ? (
          <Card className="border-allow/20 bg-allow/5">
            <CardHeader>
              <CardTitle className="text-allow">Import successful</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                <strong>{summarise(result)}</strong> in{" "}
                <code className="rounded bg-allow/10 px-2 py-1 font-mono text-xs">
                  data_live.{selectedCollection}
                </code>
              </p>
              {result.columns && result.columns.length > 0 && (
                <p>
                  Columns: <code className="font-mono text-xs">{result.columns.join(", ")}</code>
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-deny/20 bg-deny/5">
            <CardHeader>
              <CardTitle className="text-deny">Import failed</CardTitle>
              <CardDescription className="text-deny/80">{result.error}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {result.error === "validation_failed" && result.summary && (
                <ImportErrorPanel summary={result.summary} />
              )}
            </CardContent>
          </Card>
        )}

        <Button
          onClick={() => {
            setState("pick");
            setResult(null);
            setPreview(null);
            setFile(null);
          }}
        >
          Import another file
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select dataset and file</CardTitle>
        <CardDescription>Choose which collection to import data into</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="collection">
            Collection <span className="text-destructive">*</span>
          </Label>
          <Select value={selectedCollection} onValueChange={setSelectedCollection}>
            <SelectTrigger id="collection" disabled={loading}>
              <SelectValue placeholder="Select a collection..." />
            </SelectTrigger>
            <SelectContent>
              {collections.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {currentCollection && (
            <div className="mt-3 space-y-2 rounded-md bg-muted p-3">
              <p className="text-xs font-semibold text-muted-foreground">Expected columns:</p>
              <p className="text-xs text-muted-foreground">{currentMode.columns}</p>
              <div className="space-y-1">
                {currentCollection.fields
                  .filter((field) => !field.view_join && !field.relation)
                  // In delete mode only the pk is read, so listing the rest as "required"
                  // would be describing a different mode's file.
                  .filter((field) => mode !== "delete" || field.pk)
                  .map((field) => {
                    const required = mode === "append" ? field.pk || !field.nullable : field.pk;
                    const label =
                      field.name +
                      (required ? " (required)" : " (optional)") +
                      (field.posture === "deny"
                        ? " — stored, never readable through the broker"
                        : "");
                    return (
                      <div key={field.name} className="text-xs">
                        <Mono>{label}</Mono>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="mode">
            Mode <span className="text-destructive">*</span>
          </Label>
          <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <SelectTrigger id="mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{currentMode.blurb}</p>
          {mode !== "append" && currentCollection && !pkField && (
            <p className="text-xs text-deny">
              {currentCollection.name} declares no primary key, so there is nothing to address
              documents by. Only Append is available for it.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="format">
            Format <span className="text-destructive">*</span>
          </Label>
          <Select value={format} onValueChange={setFormat}>
            <SelectTrigger id="format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="csv">CSV</SelectItem>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="xlsx">Excel (.xlsx)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="file">
            File <span className="text-destructive">*</span>
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="file"
              type="file"
              accept=".csv,.json,.xlsx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={uploading}
            />
            {file && (
              <span className="text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB
              </span>
            )}
          </div>
        </div>

        <Button
          onClick={() => void handleMap()}
          disabled={!selectedCollection || !file || uploading || (mode !== "append" && !pkField)}
          className="w-full"
        >
          <Upload size={16} className="mr-2" />
          {uploading ? "Reading..." : "Map columns"}
        </Button>
        {progress && (
          <p className="text-center text-xs text-muted-foreground">
            {progress.done.toLocaleString()} / {progress.total.toLocaleString()} rows
          </p>
        )}
      </CardContent>

      <AlertDialog
        open={state === "confirm"}
        onOpenChange={(open) => {
          if (!open) {
            setState("pick");
            setPreview(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm import</AlertDialogTitle>
            {/* Radix renders AlertDialogDescription as a <p>, so these are block spans
                rather than paragraphs — a nested <p> is invalid DOM and React says so on every
                open of this dialog. */}
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                This ran against{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  data_live.{selectedCollection}
                </code>{" "}
                and was rolled back. Applying it will:
              </span>
              <span className="block font-semibold">{preview && summarise(preview)}</span>
              <span className="block text-xs">
                {mode === "delete"
                  ? "Deleted documents stop appearing in queries. Each one keeps its full revision history — nothing is erased."
                  : "Every change is a new revision. Previous values stay in the document's history rather than being overwritten."}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-800">
              These counts come from running the import for real and discarding the result, so they
              are what will happen — provided nothing else writes in between.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel
              onClick={() => {
                setState("pick");
                setPreview(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleUpload} disabled={uploading}>
              {uploading ? "Applying..." : "Apply"}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
