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
    nullable: boolean;
  }>;
}

interface ImportError {
  row: number;
  column: string;
  reason: string;
}

const ERROR_LABELS: Record<string, string> = {
  invalid_uuid: "not a UUID",
  missing_required: "required value missing",
  unknown_term: "not a term in the bound vocabulary",
  // The admin path always resolves bindings before validating, so this now means the
  // vocabulary was never applied. A term store that is merely unreachable refuses the whole
  // file as `taxonomy_unavailable` instead, and never reaches this per-column list.
  unvalidatable_term: "its vocabulary has not been applied to this stack",
  duplicate_pk: "duplicate primary key in this file",
  constraint_violation: "conflicts with data already in the collection",
  not_found: "no document with this primary key",
  no_primary_key: "this collection declares no primary key to address documents by",
};

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

type State = "pick" | "confirm" | "result";

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
};

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

  async function post(dryRun: boolean): Promise<ImportResponse | null> {
    if (!file || !selectedCollection) {
      toast.error("Please select a collection and file");
      return null;
    }
    const fd = new FormData();
    fd.set("collection", selectedCollection);
    fd.set("format", format);
    fd.set("mode", mode);
    if (dryRun) fd.set("dryRun", "1");
    fd.set("file", file);
    const res = await fetch("/api/admin/import", { method: "POST", body: fd });
    return (await res.json()) as ImportResponse;
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
              {result.error === "validation_failed" &&
                result.errors &&
                result.errors.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-semibold text-deny">Nothing was imported.</p>
                    <div className="overflow-auto rounded border border-deny/20 bg-card">
                      <div className="space-y-1 p-3 font-mono text-xs">
                        {result.errors.slice(0, 50).map((err, i) => (
                          <div key={i} className="text-deny">
                            Row {err.row} · {err.column} · {ERROR_LABELS[err.reason] || err.reason}
                          </div>
                        ))}
                        {result.errors.length > 50 && (
                          <div className="pt-2 text-deny/80">
                            ... and {result.errors.length - 50} more problems (showing the first 50)
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
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
                  .filter((field) => !field.view_join)
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
              accept=".csv,.json"
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
          onClick={handlePreview}
          disabled={!selectedCollection || !file || uploading || (mode !== "append" && !pkField)}
          className="w-full"
        >
          <Upload size={16} className="mr-2" />
          {uploading ? "Checking..." : "Preview import"}
        </Button>
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
