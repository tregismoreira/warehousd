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
};

type State = "pick" | "confirm" | "result";

export function ImportForm() {
  const [state, setState] = useState<State>("pick");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCollection, setSelectedCollection] = useState("");
  const [format, setFormat] = useState("csv");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  // `error` is the route's refusal field, matching the rest of /api. The per-row entries in
  // `errors[]` keep their own `reason` — that is a different thing from why the request failed.
  const [result, setResult] = useState<{
    ok: boolean;
    imported?: number;
    columns?: string[];
    error?: string;
    errors?: ImportError[];
  } | null>(null);

  useEffect(() => {
    const loadCollections = async () => {
      try {
        const res = await fetch("/api/admin/collections");
        const data = await res.json();
        const datasets = (data.collections as Collection[]).filter((c) => c.type !== "file");
        setCollections(datasets);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Failed to load collections: ${msg}`);
      } finally {
        setLoading(false);
      }
    };
    void loadCollections();
  }, []);

  const currentCollection = collections.find((c) => c.name === selectedCollection);

  async function handleUpload() {
    if (!file || !selectedCollection) {
      toast.error("Please select a collection and file");
      return;
    }

    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("collection", selectedCollection);
      fd.set("format", format);
      fd.set("file", file);

      const res = await fetch("/api/admin/import", {
        method: "POST",
        body: fd,
      });

      const body = await res.json();
      setResult(body);

      if (body.ok) {
        toast.success(`Imported ${body.imported} row${body.imported !== 1 ? "s" : ""}`);
      }
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
                <strong>{result.imported}</strong> row{result.imported !== 1 ? "s" : ""} imported
                into{" "}
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
              <div className="space-y-1">
                {currentCollection.fields
                  .filter((field) => !field.view_join)
                  .map((field) => {
                    const label =
                      field.name +
                      (field.pk || !field.nullable ? " (required)" : " (nullable)") +
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
          onClick={() => setState("confirm")}
          disabled={!selectedCollection || !file || uploading}
          className="w-full"
        >
          <Upload size={16} className="mr-2" />
          Review import
        </Button>
      </CardContent>

      <AlertDialog
        open={state === "confirm"}
        onOpenChange={(open) => {
          if (!open) setState("pick");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm import</AlertDialogTitle>
            {/* Radix renders AlertDialogDescription as a <p>, so these two are block spans
                rather than paragraphs — a nested <p> is invalid DOM and React says so on every
                open of this dialog. */}
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                This imports {file && (file.size / 1024 / 1024).toFixed(1)} MB into{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  data_live.{selectedCollection}
                </code>
                .
              </span>
              <span className="block text-xs">
                Imports are append-only — nothing already there is modified, and this cannot be
                undone from the UI.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-800">
              Verify the file is correct before proceeding. Invalid rows will be rejected and
              logged.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel onClick={() => setState("pick")}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleUpload} disabled={uploading}>
              {uploading ? "Uploading..." : "Import"}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
