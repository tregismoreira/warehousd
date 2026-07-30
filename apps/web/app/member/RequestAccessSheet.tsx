"use client";
import { useEffect, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

type Coll = {
  name: string;
  description: string;
  type: string;
  grantableFields: string[];
  alreadyGranted: boolean;
};

export function RequestAccessSheet({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [colls, setColls] = useState<Coll[]>([]);
  const [collection, setCollection] = useState("");
  const [purposeLabel, setPurposeLabel] = useState("");
  const [purposeDetail, setPurposeDetail] = useState("");
  const [fields, setFields] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    void fetch("/api/me/collections")
      .then((r) => r.json())
      .then((d) => setColls(d.collections ?? []));
  }, [open]);

  const selected = colls.find((c) => c.name === collection);

  useEffect(() => {
    setFields(new Set(selected?.grantableFields ?? []));
  }, [collection]);

  async function submit() {
    setSubmitting(true);
    const res = await fetch("/api/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "request",
        collection,
        purposeLabel,
        purposeDetail,
        fields: Array.from(fields),
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error("Request failed", { description: (await res.json()).error });
      return;
    }
    toast.success("Access requested", { description: "A manager will review it." });
    setOpen(false);
    setCollection("");
    setPurposeLabel("");
    setPurposeDetail("");
    onDone();
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus size={16} className="mr-2" />
          Request access
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Request access</SheetTitle>
          <SheetDescription>
            State what you need the data for. Purpose is stamped on every audit event this grant
            produces.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4">
          <div className="space-y-2">
            <Label htmlFor="collection">
              Collection <span className="text-destructive">*</span>
            </Label>
            <Select value={collection} onValueChange={setCollection}>
              <SelectTrigger id="collection">
                <SelectValue placeholder="Pick a collection" />
              </SelectTrigger>
              <SelectContent>
                {colls.map((c) => (
                  <SelectItem key={c.name} value={c.name} disabled={c.alreadyGranted}>
                    {c.name}
                    {c.alreadyGranted ? " — already requested" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && <p className="text-xs text-muted-foreground">{selected.description}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="purpose">
              Purpose <span className="text-destructive">*</span>
            </Label>
            <Input
              id="purpose"
              placeholder="onboarding prep"
              value={purposeLabel}
              onChange={(e) => setPurposeLabel(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">A short label. Shown to your approver.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="detail">Detail</Label>
            <Textarea
              id="detail"
              rows={3}
              value={purposeDetail}
              onChange={(e) => setPurposeDetail(e.target.value)}
            />
          </div>

          {selected && (
            <div className="space-y-2">
              <Label>Fields</Label>
              <p className="text-xs text-muted-foreground">
                Only fields the configuration allows are listed. Your approver can trim this
                further, never widen it.
              </p>
              <div className="space-y-1.5 rounded-md border p-3">
                {selected.grantableFields.map((f) => (
                  <label key={f} className="flex items-center gap-2 font-mono text-xs">
                    <Checkbox
                      checked={fields.has(f)}
                      onCheckedChange={(v) => {
                        const next = new Set(fields);
                        if (v) next.add(f);
                        else next.delete(f);
                        setFields(next);
                      }}
                    />
                    {f}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || !collection || !purposeLabel.trim() || fields.size === 0}
          >
            {submitting && <Loader2 size={16} className="mr-2 animate-spin" />}
            Submit request
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
