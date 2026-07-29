"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Mono } from "@/components/common/Mono";

type TrustedIssuer = {
  id: string;
  issuer: string;
};

export function NewApiKeyDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"delegated" | "headless" | "">("");
  const [trustedIssuerId, setTrustedIssuerId] = useState("");
  const [robotUserId, setRobotUserId] = useState("");
  const [allowedCollections, setAllowedCollections] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [issuers, setIssuers] = useState<TrustedIssuer[]>([]);
  const [issuersLoaded, setIssuersLoaded] = useState(false);
  const [created, setCreated] = useState<{ clientId: string; secret: string } | null>(null);
  const [loadingIssuers, setLoadingIssuers] = useState(false);

  useEffect(() => {
    if (open && mode === "delegated" && !issuersLoaded) {
      setLoadingIssuers(true);
      fetch("/api/trusted-issuers")
        .then(r => r.json())
        .then(data => { setIssuers(data.issuers); setIssuersLoaded(true); })
        .catch(e => toast.error(`Failed to load issuers: ${e.message}`))
        .finally(() => setLoadingIssuers(false));
    }
  }, [open, mode, issuersLoaded]);

  async function submit() {
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          mode,
          trustedIssuerId: mode === "delegated" ? trustedIssuerId : undefined,
          robotUserId: mode === "headless" ? robotUserId.trim() : undefined,
          allowedCollections: allowedCollections.trim() ? allowedCollections.split(",").map(c => c.trim()) : null,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error("Failed to create API key", { description: err.error });
        return;
      }
      const result = await res.json();
      setCreated(result);
      onCreated();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to create API key: ${msg}`);
    }
  }

  const isValid = name.trim() && mode && (
    (mode === "delegated" && trustedIssuerId) ||
    (mode === "headless" && robotUserId.trim())
  );

  return (
    <Dialog open={open} onOpenChange={(v) => {
      setOpen(v);
      if (!v) {
        setCreated(null);
        setName("");
        setMode("");
        setTrustedIssuerId("");
        setRobotUserId("");
        setAllowedCollections("");
        setExpiresAt("");
      }
    }}>
      <DialogTrigger asChild>
        <Button><Plus size={16} className="mr-2" />New key</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                Copy the secret now — it is not stored in a form we can show you again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Client ID</Label>
                <Mono copyable className="text-sm">{created.clientId}</Mono>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Secret</Label>
                <Mono copyable className="text-sm font-bold">{created.secret}</Mono>
              </div>
              <p className="flex items-start gap-2 rounded-md border border-pending/40 p-3 text-xs text-muted-foreground">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-pending" />
                This secret is <b className="mx-1 font-mono">whd_dev_*</b> by default and can only
                ever access synthetic data. Rotate to issue a live secret, then ask a manager to promote
                it if access to live data is needed.
              </p>
            </div>
            <DialogFooter><Button onClick={() => setOpen(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Create a credential for programmatic REST API access. Revocation takes effect immediately.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Name <span className="text-destructive">*</span></Label>
                <Input id="name" placeholder="Data sync job"
                  value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div>
                <Label htmlFor="mode">Mode <span className="text-destructive">*</span></Label>
                <Select value={mode} onValueChange={(v) => { setMode(v as "delegated" | "headless"); setTrustedIssuerId(""); setRobotUserId(""); }}>
                  <SelectTrigger id="mode">
                    <SelectValue placeholder="Select mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="delegated">Delegated (OAuth SSO)</SelectItem>
                    <SelectItem value="headless">Headless (robot user)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {mode === "delegated" && (
                <div>
                  <Label htmlFor="issuer">Trusted issuer <span className="text-destructive">*</span></Label>
                  <Select value={trustedIssuerId} onValueChange={setTrustedIssuerId} disabled={loadingIssuers}>
                    <SelectTrigger id="issuer">
                      <SelectValue placeholder={loadingIssuers ? "Loading..." : "Select issuer"} />
                    </SelectTrigger>
                    <SelectContent>
                      {issuers.map((issuer) => (
                        <SelectItem key={issuer.id} value={issuer.id}>
                          {issuer.issuer}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {mode === "headless" && (
                <div>
                  <Label htmlFor="robotUserId">Robot user ID <span className="text-destructive">*</span></Label>
                  <Input id="robotUserId" placeholder="service-account-123"
                    value={robotUserId} onChange={(e) => setRobotUserId(e.target.value)} />
                </div>
              )}

              <div>
                <Label htmlFor="collections">Collection ceiling (comma-separated, optional)</Label>
                <Input id="collections" placeholder="documents, users"
                  value={allowedCollections} onChange={(e) => setAllowedCollections(e.target.value)} />
              </div>

              <div>
                <Label htmlFor="expiresAt">Expiry date (optional)</Label>
                <Input id="expiresAt" type="date"
                  value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={!isValid} onClick={submit}>Create</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
