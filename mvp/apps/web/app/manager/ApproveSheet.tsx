"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Mono } from "@/components/common/Mono";

export type PendingGrant = {
  id: string; user_id: string; collection: string; env: "dev" | "live";
  allowed_fields: string[] | null; purpose_label: string | null; purpose_detail: string | null;
  requested_at: string; collectionType?: string; taxonomyField?: string | null;
};

export function ApproveSheet({
  grant, open, onOpenChange, onDone,
}: {
  grant: PendingGrant | null; open: boolean;
  onOpenChange: (v: boolean) => void; onDone: () => void;
}) {
  const [fields, setFields] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [terms, setTerms] = useState<{ slug: string; label: string }[]>([]);
  const [pickedPaths, setPickedPaths] = useState<Set<string>>(new Set());
  const [pickedTerms, setPickedTerms] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!grant) return;
    setFields(new Set(grant.allowed_fields ?? []));
    setPickedPaths(new Set()); setPickedTerms(new Set());
    setExpiresAt(""); setPaths([]); setTerms([]);

    if (grant.collectionType === "file") {
      fetch(`/api/grants/doc-paths?collection=${grant.collection}&env=${grant.env}`)
        .then((r) => r.json()).then((d) => setPaths(d.paths ?? []));
    }
    if (grant.taxonomyField) {
      fetch(`/api/grants/terms?collection=${grant.collection}`)
        .then((r) => r.json()).then((d) => setTerms(d.terms ?? []));
    }
  }, [grant]);

  async function act(action: "approve" | "deny") {
    if (!grant) return;
    setBusy(true);
    const res = await fetch("/api/grants", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(
        action === "deny"
          ? { action, id: grant.id }
          : {
              action, id: grant.id,
              allowedFields: Array.from(fields),
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
              selectedPaths: Array.from(pickedPaths),
              selectedTerms: Array.from(pickedTerms),
            }),
    });
    setBusy(false);
    if (!res.ok) { toast.error("Failed", { description: (await res.json()).error }); return; }
    toast.success(action === "approve" ? "Grant approved" : "Request denied");
    onOpenChange(false); onDone();
  }

  if (!grant) return null;
  const scoped = pickedTerms.size > 0 || pickedPaths.size > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Review request</SheetTitle>
          <SheetDescription>
            <Mono>{grant.user_id}</Mono> wants <Mono>{grant.collection}</Mono> in{" "}
            <Mono>{grant.env}</Mono>
            {grant.purpose_label ? <> for <b>{grant.purpose_label}</b></> : null}.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4">
          {grant.purpose_detail && (
            <p className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
              {grant.purpose_detail}
            </p>
          )}

          <div className="space-y-2">
            <Label>Fields</Label>
            <p className="text-xs text-muted-foreground">
              Uncheck to trim. You cannot add fields the requester did not ask for.
            </p>
            <div className="space-y-1.5 rounded-md border p-3">
              {(grant.allowed_fields ?? []).map((f) => (
                <label key={f} className="flex items-center gap-2 font-mono text-xs">
                  <Checkbox
                    checked={fields.has(f)}
                    onCheckedChange={(v) => {
                      const next = new Set(fields);
                      if (v) next.add(f); else next.delete(f);
                      setFields(next);
                    }}
                  />
                  {f}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expiry">Expires</Label>
            <Input id="expiry" type="datetime-local"
              value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Leave empty for no expiry. An expired grant behaves exactly like a revoked one.
            </p>
          </div>

          {terms.length > 0 && (
            <div className="space-y-2">
              <Label>Categories</Label>
              <p className="text-xs text-muted-foreground">
                Restrict the grant to these categories. Overrides file selection.
              </p>
              <div className="space-y-1.5 rounded-md border p-3">
                {terms.map((t) => (
                  <label key={t.slug} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={pickedTerms.has(t.slug)}
                      onCheckedChange={(v) => {
                        const next = new Set(pickedTerms);
                        if (v) next.add(t.slug); else next.delete(t.slug);
                        setPickedTerms(next);
                      }}
                    />
                    {t.label} <Mono className="text-muted-foreground">{t.slug}</Mono>
                  </label>
                ))}
              </div>
            </div>
          )}

          {paths.length > 0 && pickedTerms.size === 0 && (
            <div className="space-y-2">
              <Label>Files</Label>
              <div className="space-y-1.5 rounded-md border p-3">
                {paths.map((p) => (
                  <label key={p} className="flex items-center gap-2 font-mono text-xs">
                    <Checkbox
                      checked={pickedPaths.has(p)}
                      onCheckedChange={(v) => {
                        const next = new Set(pickedPaths);
                        if (v) next.add(p); else next.delete(p);
                        setPickedPaths(next);
                      }}
                    />
                    {p}
                  </label>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {scoped
              ? "This grant will be restricted to the selection above. Everything else is silently absent."
              : "No document restriction — this grant reaches the whole collection."}
          </p>
        </div>

        <SheetFooter>
          <Button variant="outline" disabled={busy} onClick={() => act("deny")}>Deny</Button>
          <Button disabled={busy || fields.size === 0} onClick={() => act("approve")}>
            {busy && <Loader2 size={16} className="mr-2 animate-spin" />}
            Approve
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
