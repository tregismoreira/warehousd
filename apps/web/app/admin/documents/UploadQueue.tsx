"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FolderOpen, Files, Pause, Play, RotateCcw } from "lucide-react";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mono } from "@/components/common/Mono";
import { requestJson } from "@/lib/client-api";

// How many uploads are in flight at once. Enough to keep a connection busy on a corpus of small
// documents; low enough that a slow extraction (a large PDF) does not queue behind three others
// on the server. Raising it does not make a single large file arrive sooner.
const CONCURRENCY = 4;
// Per file, on a transport failure only. A refusal — wrong type, missing term, too large — is
// not retried: it will be refused identically every time, and hiding that behind three attempts
// only delays telling the person who can fix it.
const MAX_ATTEMPTS = 3;

const ACCEPTED = [".md", ".txt", ".pdf", ".docx"];

type ItemState = "pending" | "hashing" | "planned" | "skip" | "uploading" | "done" | "failed";

type Item = {
  file: File;
  path: string;
  checksum: string | null;
  state: ItemState;
  attempts: number;
  detail: string | null;
  /** From the plan: `changed` means this path already exists with different bytes. */
  plan: "new" | "changed" | "unchanged" | null;
};

type Collection = { name: string; type: string; description: string };
type Vocab = {
  field: string;
  label: string;
  multiple: boolean;
  applied: boolean;
  terms: { slug: string; label: string }[];
};
type MetadataField = { field: string; type: string };
type CollectionDetail = { taxonomies: Vocab[]; metadataFields: MetadataField[] };

const REFUSALS: Record<string, string> = {
  unsupported_type: "not a .md, .txt, .pdf or .docx",
  too_large: "larger than the upload limit",
  empty: "the file is empty",
  checksum_mismatch: "the bytes changed between hashing and upload",
  invalid_path: "the path contains something that cannot be stored",
  not_a_file_collection: "this collection does not hold documents",
  rejected: "rejected",
};

// A browser's directory picker reports `Folder/sub/file.pdf`; a plain multi-select reports only
// the name. Either way the path is the document's identity, and re-uploading it is a revision of
// the same document rather than a duplicate.
function pathOf(f: File): string {
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel && rel.length > 0 ? rel : f.name;
}

function accepted(path: string): boolean {
  return ACCEPTED.some((e) => path.toLowerCase().endsWith(e));
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function UploadQueue({ env }: { env: "dev" | "live" }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collection, setCollection] = useState("");
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [owner, setOwner] = useState("");
  const [terms, setTerms] = useState<Record<string, string>>({});
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);

  // The loop reads these on every tick, so they cannot be captured state — a paused queue that
  // resumed into a stale closure would upload with the settings it started with.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const res = await requestJson<{ collections: Collection[] }>("/api/admin/collections");
      if (!res.ok) toast.error(`Failed to load collections: ${res.error}`);
      else setCollections(res.data.collections.filter((c) => c.type === "file"));
    })();
  }, []);

  useEffect(() => {
    if (!collection) return setDetail(null);
    void (async () => {
      const res = await requestJson<CollectionDetail>(
        `/api/admin/collections/${encodeURIComponent(collection)}`,
      );
      if (!res.ok) toast.error(`Failed to load ${collection}: ${res.error}`);
      else setDetail(res.data);
      setTerms({});
      setMetadata({});
    })();
  }, [collection]);

  const update = useCallback((path: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.path === path ? { ...it, ...patch } : it)));
  }, []);

  // Selecting files hashes them and asks the server which it already holds. This is the whole of
  // "resume later": the answer comes from the database, not from anything this tab remembers, so
  // re-selecting the same folder after a crash, a reload or on another machine skips everything
  // that already landed and uploads only the rest.
  async function onPick(files: FileList | null) {
    if (!files || !collection) return;
    const picked = [...files].filter((f) => accepted(pathOf(f)));
    const ignored = files.length - picked.length;
    if (ignored > 0) toast.info(`${ignored} file(s) skipped — only ${ACCEPTED.join(", ")}`);
    if (picked.length === 0) return;

    const seeded: Item[] = picked.map((file) => ({
      file,
      path: pathOf(file),
      checksum: null,
      state: "hashing",
      attempts: 0,
      detail: null,
      plan: null,
    }));
    setItems(seeded);

    const hashed: Item[] = [];
    for (const it of seeded) {
      const checksum = await sha256(it.file);
      const next = { ...it, checksum, state: "pending" as ItemState };
      hashed.push(next);
      update(it.path, { checksum, state: "pending" });
    }

    const res = await requestJson<{ plan: { path: string; status: Item["plan"] }[] }>(
      "/api/admin/documents/plan",
      {
        method: "POST",
        body: JSON.stringify({
          collection,
          env,
          files: hashed.map((h) => ({ path: h.path, checksum: h.checksum })),
        }),
      },
    );
    if (!res.ok) {
      toast.error(`Could not check what is already stored: ${res.error}`);
      return;
    }
    const byPath = new Map(res.data.plan.map((p) => [p.path, p.status]));
    setItems(
      hashed.map((h) => {
        const plan = byPath.get(h.path) ?? "new";
        return {
          ...h,
          plan,
          state: plan === "unchanged" ? "skip" : "planned",
        };
      }),
    );
  }

  const sidecar = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (owner.trim()) out.owner = owner.trim();
    for (const v of detail?.taxonomies ?? []) {
      const value = terms[v.field];
      if (!value) continue;
      out[v.field] = v.multiple ? [value] : value;
    }
    for (const m of detail?.metadataFields ?? []) {
      const value = metadata[m.field];
      if (value !== undefined && value !== "") out[m.field] = value;
    }
    return out;
  }, [owner, terms, metadata, detail]);

  async function uploadOne(it: Item): Promise<void> {
    const fd = new FormData();
    fd.set("collection", collection);
    fd.set("env", env);
    fd.set("path", it.path);
    if (it.checksum) fd.set("checksum", it.checksum);
    fd.set("sidecar", JSON.stringify(sidecar));
    fd.set("file", it.file);
    const res = await fetch("/api/admin/documents", { method: "POST", body: fd });
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      detail?: string;
    } | null;
    if (res.ok) return;
    // 5xx is the transport-ish case worth another attempt; a 4xx is a decision about this file.
    const message =
      body?.detail ?? REFUSALS[body?.error ?? ""] ?? body?.error ?? `HTTP ${res.status}`;
    const err = new Error(message);
    (err as Error & { retryable?: boolean }).retryable = res.status >= 500;
    throw err;
  }

  // A fixed pool of workers pulling from one queue, rather than a batch-of-four loop: one slow
  // file must not hold three idle slots behind it, which is most of the difference between this
  // feeling fast and feeling like it stalled.
  const run = useCallback(async () => {
    setRunning(true);
    const queue = itemsRef.current.filter((i) => i.state === "planned" || i.state === "failed");
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        while (pausedRef.current) await new Promise((r) => setTimeout(r, 200));
        const it = queue[cursor++];
        if (!it) return;
        update(it.path, { state: "uploading" });
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            await uploadOne(it);
            update(it.path, { state: "done", detail: null, attempts: attempt });
            break;
          } catch (e) {
            const retryable = (e as Error & { retryable?: boolean }).retryable === true;
            if (!retryable || attempt === MAX_ATTEMPTS) {
              update(it.path, {
                state: "failed",
                detail: e instanceof Error ? e.message : String(e),
                attempts: attempt,
              });
              break;
            }
            await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setRunning(false);
    const failed = itemsRef.current.filter((i) => i.state === "failed").length;
    if (failed === 0) toast.success("Upload complete");
    else toast.error(`${failed} file(s) could not be uploaded`);
  }, [collection, env, sidecar, update]);

  const counts = useMemo(() => {
    const by = (s: ItemState) => items.filter((i) => i.state === s).length;
    return {
      total: items.length,
      done: by("done"),
      skip: by("skip"),
      failed: by("failed"),
      queued: by("planned") + by("uploading"),
    };
  }, [items]);

  const missingTerm = (detail?.taxonomies ?? []).find((v) => v.applied && !terms[v.field]);
  const ready = collection && items.some((i) => i.state === "planned") && !missingTerm;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Where the documents go</CardTitle>
          <CardDescription>
            Uploading the same path again revises that document rather than adding a second copy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="collection">
                Collection <span className="text-destructive">*</span>
              </Label>
              <Select value={collection} onValueChange={setCollection}>
                <SelectTrigger id="collection">
                  <SelectValue placeholder="Select a file collection..." />
                </SelectTrigger>
                <SelectContent>
                  {collections.map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Environment</Label>
              <p className="pt-2 text-sm">
                Uploading into <Mono>{env}</Mono> —{" "}
                {env === "live" ? "real content" : "the synthetic sandbox"}. Change it with the
                environment switcher in the header.
              </p>
            </div>
          </div>

          {detail && (detail.taxonomies.length > 0 || detail.metadataFields.length > 0) && (
            <div className="space-y-4 rounded-md bg-muted p-4">
              <p className="text-xs text-muted-foreground">
                Applied to every file in this batch, exactly as a sidecar <Mono>.yml</Mono> would
                be. A <Mono>.md</Mono> or <Mono>.txt</Mono> file carries its own frontmatter and
                that wins — these fill in what a PDF or DOCX cannot say for itself.
              </p>
              <div className="space-y-2">
                <Label htmlFor="owner">Owner</Label>
                <Input
                  id="owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="who this document belongs to"
                />
              </div>
              {detail.taxonomies.map((v) => (
                <div key={v.field} className="space-y-2">
                  <Label htmlFor={`t-${v.field}`}>
                    {v.label} <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={terms[v.field] ?? ""}
                    onValueChange={(val) => setTerms((p) => ({ ...p, [v.field]: val }))}
                  >
                    <SelectTrigger id={`t-${v.field}`} disabled={!v.applied}>
                      <SelectValue
                        placeholder={
                          v.applied ? "Select a term..." : "not applied to this environment"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {v.terms.map((t) => (
                        <SelectItem key={t.slug} value={t.slug}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              {detail.metadataFields.map((m) => (
                <div key={m.field} className="space-y-2">
                  <Label htmlFor={`m-${m.field}`}>
                    {m.field} <span className="text-muted-foreground">({m.type})</span>
                  </Label>
                  <Input
                    id={`m-${m.field}`}
                    value={metadata[m.field] ?? ""}
                    onChange={(e) => setMetadata((p) => ({ ...p, [m.field]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}

          {missingTerm && items.length > 0 && (
            <p className="text-sm text-deny">
              {missingTerm.label} is a bound vocabulary and every document needs a term from it. An
              unscoped document would be reachable by a grant approved on the assumption it carried
              one.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Choose files</CardTitle>
          <CardDescription>
            Each file is hashed here in the browser, then checked against what the collection
            already holds. Anything already stored byte for byte is skipped — so if this is
            interrupted, pick the same folder again and it carries on where it stopped.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Real buttons driving hidden inputs, rather than the inputs dressed as buttons: a
              `<label>` cannot be disabled, so "you have not chosen a collection yet" would be a
              greyed-out control that still opened a file picker. The inputs carry an aria-label
              because a hidden input has no accessible name otherwise. */}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={!collection}
              onClick={() => filesRef.current?.click()}
            >
              <Files className="mr-2 size-4" />
              Select files
            </Button>
            <Button
              variant="outline"
              disabled={!collection}
              onClick={() => folderRef.current?.click()}
            >
              <FolderOpen className="mr-2 size-4" />
              Select a folder
            </Button>
            <input
              ref={filesRef}
              type="file"
              multiple
              aria-label="Choose files"
              accept={ACCEPTED.join(",")}
              className="hidden"
              onChange={(e) => void onPick(e.target.files)}
            />
            <input
              ref={folderRef}
              type="file"
              aria-label="Choose a folder"
              className="hidden"
              // webkitdirectory is how a browser offers a folder; React does not type it.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              {...({ webkitdirectory: "", directory: "" } as any)}
              onChange={(e) => void onPick(e.target.files)}
            />
          </div>

          {items.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span>
                  <strong>{counts.done}</strong> uploaded
                </span>
                <span className="text-muted-foreground">{counts.skip} already stored</span>
                <span className="text-muted-foreground">{counts.queued} queued</span>
                {counts.failed > 0 && <span className="text-deny">{counts.failed} failed</span>}
                <span className="text-muted-foreground">of {counts.total}</span>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void run()} disabled={!ready || running}>
                  Upload {items.filter((i) => i.state === "planned").length} file(s)
                </Button>
                {running && (
                  <Button variant="outline" onClick={() => setPaused((p) => !p)}>
                    {paused ? (
                      <>
                        <Play className="mr-2 size-4" /> Resume
                      </>
                    ) : (
                      <>
                        <Pause className="mr-2 size-4" /> Pause
                      </>
                    )}
                  </Button>
                )}
                {!running && counts.failed > 0 && (
                  <Button variant="outline" onClick={() => void run()}>
                    <RotateCcw className="mr-2 size-4" /> Retry {counts.failed} failed
                  </Button>
                )}
              </div>

              <div className="max-h-96 overflow-auto rounded border">
                <table className="w-full text-sm">
                  <tbody>
                    {items.map((it) => (
                      <tr key={it.path} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{it.path}</td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {it.state === "skip"
                            ? "already stored"
                            : it.state === "done"
                              ? it.plan === "changed"
                                ? "revised"
                                : "uploaded"
                              : it.state === "failed"
                                ? (it.detail ?? "failed")
                                : it.state}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
