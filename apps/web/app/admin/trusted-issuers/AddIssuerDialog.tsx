"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { requestJson } from "@/lib/client-api";

export function AddIssuerDialog({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [jwksUri, setJwksUri] = useState("");
  const [audience, setAudience] = useState("");
  const [subjectClaim, setSubjectClaim] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setIssuer("");
    setJwksUri("");
    setAudience("");
    setSubjectClaim("");
  }

  async function submit() {
    setSaving(true);
    try {
      const res = await requestJson("/api/trusted-issuers", {
        method: "POST",
        body: JSON.stringify({
          issuer: issuer.trim(),
          jwksUri: jwksUri.trim(),
          audience: audience.trim(),
          // Blank means the server's default of `sub`; don't send an empty string.
          subjectClaim: subjectClaim.trim() || undefined,
        }),
      });
      if (!res.ok) {
        toast.error("Failed to add issuer", { description: res.error });
        return;
      }
      toast.success("Trusted issuer added");
      setOpen(false);
      reset();
      await onCreated();
    } finally {
      setSaving(false);
    }
  }

  const isValid = issuer.trim() && jwksUri.trim() && audience.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus size={16} className="mr-2" />
          Add issuer
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a trusted issuer</DialogTitle>
          <DialogDescription>
            Tokens from this issuer may be exchanged for a warehousd token. The subject claim must
            resolve to a warehousd user&apos;s email, or the exchange is refused.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="issuer">
              Issuer URL <span className="text-destructive">*</span>
            </Label>
            <Input
              id="issuer"
              placeholder="https://idp.example.com"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="jwksUri">
              JWKS URI <span className="text-destructive">*</span>
            </Label>
            <Input
              id="jwksUri"
              placeholder="https://idp.example.com/.well-known/jwks.json"
              value={jwksUri}
              onChange={(e) => setJwksUri(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="audience">
              Audience <span className="text-destructive">*</span>
            </Label>
            <Input
              id="audience"
              placeholder="warehousd"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="subjectClaim">Subject claim (optional)</Label>
            <Input
              id="subjectClaim"
              placeholder="sub"
              value={subjectClaim}
              onChange={(e) => setSubjectClaim(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!isValid || saving} onClick={submit}>
            Add issuer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
