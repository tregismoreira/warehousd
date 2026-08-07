"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Mono } from "@/components/common/Mono";
import { requestJson } from "@/lib/client-api";
import { AccessExplainer } from "@/app/components/AccessExplainer";

export type PendingGrant = {
  id: string;
  user_id: string;
  collection: string;
  env: "dev" | "live";
  allowed_fields: string[] | null;
  purpose_label: string | null;
  purpose_detail: string | null;
  requested_at: string;
  collectionType?: string;
  taxonomyFields?: string[];
  unmaskableFields?: string[];
};

type Vocabulary = {
  field: string;
  label: string;
  multiple: boolean;
  terms: { slug: string; label: string }[];
};

export function ApproveSheet({
  grant,
  open,
  onOpenChange,
  onDone,
}: {
  grant: PendingGrant | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [fields, setFields] = useState<Set<string>>(new Set());
  // Raw-value grants, a strict subset of `fields`. Separate state because it is a separate
  // decision: trimming the field list narrows what is seen, ticking this widens it.
  const [unmasked, setUnmasked] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [vocabularies, setVocabularies] = useState<Vocabulary[]>([]);
  const [pickedPaths, setPickedPaths] = useState<Set<string>>(new Set());
  const [pickedTermsByField, setPickedTermsByField] = useState<Record<string, Set<string>>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!grant) return;
    setFields(new Set(grant.allowed_fields ?? []));
    // Never pre-ticked. The default for a masked field is masked, and an approver has to choose
    // the wider option deliberately rather than inherit it from a previous grant.
    setUnmasked(new Set());
    setPickedPaths(new Set());
    setPickedTermsByField({});
    setExpiresAt("");
    setPaths([]);
    setVocabularies([]);

    if (grant.collectionType === "file") {
      void requestJson<{ paths?: string[] }>(
        `/api/grants/doc-paths?collection=${grant.collection}&env=${grant.env}`,
      ).then((r) => {
        if (r.ok) setPaths(r.data.paths ?? []);
      });
    }
    if (grant.taxonomyFields && grant.taxonomyFields.length > 0) {
      void requestJson<{ vocabularies?: Vocabulary[] }>(
        `/api/grants/terms?collection=${grant.collection}`,
      ).then((r) => {
        if (!r.ok) return;
        const vocabs = r.data.vocabularies ?? [];
        setVocabularies(vocabs);
        const picked: Record<string, Set<string>> = {};
        for (const vocab of vocabs) picked[vocab.field] = new Set();
        setPickedTermsByField(picked);
      });
    }
  }, [grant]);

  async function act(action: "approve" | "deny") {
    if (!grant) return;
    setBusy(true);
    // Flatten pickedTermsByField into selectedTerms: { field: [terms...] }
    const selectedTerms: Record<string, string[]> = {};
    for (const [field, terms] of Object.entries(pickedTermsByField)) {
      if (terms.size > 0) selectedTerms[field] = Array.from(terms);
    }
    const res = await requestJson("/api/grants", {
      method: "POST",
      body: JSON.stringify(
        action === "deny"
          ? { action, id: grant.id }
          : {
              action,
              id: grant.id,
              allowedFields: Array.from(fields),
              unmaskedFields: Array.from(unmasked),
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
              selectedPaths: Array.from(pickedPaths),
              selectedTerms,
            },
      ),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error("Failed", { description: res.error });
      return;
    }
    toast.success(action === "approve" ? "Grant approved" : "Request denied");
    onOpenChange(false);
    onDone();
  }

  if (!grant) return null;
  const scopedTerms = Object.values(pickedTermsByField).some((s) => s.size > 0);
  const scoped = scopedTerms || pickedPaths.size > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Review request</SheetTitle>
          <SheetDescription>
            <Mono>{grant.user_id}</Mono> wants <Mono>{grant.collection}</Mono> in{" "}
            <Mono>{grant.env}</Mono>
            {grant.purpose_label ? (
              <>
                {" "}
                for <b>{grant.purpose_label}</b>
              </>
            ) : null}
            .
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
              {(grant.allowed_fields ?? []).map((f) => {
                const unmaskable = (grant.unmaskableFields ?? []).includes(f);
                return (
                  <div key={f} className="space-y-1">
                    <label className="flex items-center gap-2 font-mono text-xs">
                      <Checkbox
                        checked={fields.has(f)}
                        onCheckedChange={(v) => {
                          const next = new Set(fields);
                          const nextUnmasked = new Set(unmasked);
                          if (v) next.add(f);
                          else {
                            next.delete(f);
                            // Unmasking a field that is not granted is meaningless, and the
                            // server refuses it — so untick it here rather than let the form
                            // submit a combination it will be told off for.
                            nextUnmasked.delete(f);
                          }
                          setFields(next);
                          setUnmasked(nextUnmasked);
                        }}
                      />
                      {f}
                    </label>
                    {unmaskable && fields.has(f) && (
                      <label className="ml-6 flex items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={unmasked.has(f)}
                          onCheckedChange={(v) => {
                            const next = new Set(unmasked);
                            if (v) next.add(f);
                            else next.delete(f);
                            setUnmasked(next);
                          }}
                        />
                        Show the real value (this field is masked by default)
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expiry">Expires</Label>
            <Input
              id="expiry"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty for no expiry. An expired grant behaves exactly like a revoked one.
            </p>
          </div>

          {vocabularies.length > 0 && (
            <div className="space-y-4">
              {vocabularies.map((vocab) => (
                <div key={vocab.field} className="space-y-2">
                  <Label>{vocab.label}</Label>
                  <p className="text-xs text-muted-foreground">
                    {vocab.multiple ? "Select one or more. " : "Select one. "}
                    Combined with every other selection below by AND.
                  </p>
                  <div className="space-y-1.5 rounded-md border p-3">
                    {vocab.terms.map((t) => (
                      <label key={t.slug} className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={pickedTermsByField[vocab.field]?.has(t.slug) ?? false}
                          onCheckedChange={(v) => {
                            const next = new Map(
                              Object.entries(pickedTermsByField).map(([k, s]) => [k, new Set(s)]),
                            );
                            const fieldTerms = next.get(vocab.field) || new Set<string>();
                            if (v) fieldTerms.add(t.slug);
                            else fieldTerms.delete(t.slug);
                            next.set(vocab.field, fieldTerms);
                            setPickedTermsByField(Object.fromEntries(next));
                          }}
                        />
                        {t.label} <Mono className="text-muted-foreground">{t.slug}</Mono>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {paths.length > 0 && (
            <div className="space-y-2">
              <Label>Files</Label>
              <div className="space-y-1.5 rounded-md border p-3">
                {paths.map((p) => (
                  <label key={p} className="flex items-center gap-2 font-mono text-xs">
                    <Checkbox
                      checked={pickedPaths.has(p)}
                      onCheckedChange={(v) => {
                        const next = new Set(pickedPaths);
                        if (v) next.add(p);
                        else next.delete(p);
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

          {/* §P5. An approver used to pick fields with no preview: no statement of what the
              requester already inherits, and no way to tell a document filter that scopes access
              from one that matches nothing. */}
          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-semibold text-muted-foreground">
              What {grant.user_id} can see today
            </p>
            <AccessExplainer collection={grant.collection} subject={grant.user_id} />
          </div>
        </div>

        <SheetFooter>
          <Button variant="outline" disabled={busy} onClick={() => act("deny")}>
            Deny
          </Button>
          <Button disabled={busy || fields.size === 0} onClick={() => act("approve")}>
            {busy && <Loader2 size={16} className="mr-2 animate-spin" />}
            Approve
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
