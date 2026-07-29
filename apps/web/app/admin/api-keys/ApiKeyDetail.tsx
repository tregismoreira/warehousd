"use client";
import { useState } from "react";
import { AlertTriangle, ArrowLeft, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Mono } from "@/components/common/Mono";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ApiKey, ClientSecretInfo } from "./ApiKeysTable";
import { AuditBrowser } from "../audit/AuditBrowser";

export function ApiKeyDetail({ keyData, onClose, onRefresh }: { keyData: ApiKey; onClose: () => void; onRefresh: () => Promise<void> }) {
  const [rotating, setRotating] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [editingCeiling, setEditingCeiling] = useState(false);
  const [newCeiling, setNewCeiling] = useState(keyData.allowedCollections?.join(", ") ?? "");
  const [rotatedSecret, setRotatedSecret] = useState<{ secret: string; id: string } | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  const activeSecret = keyData.secrets.find(s => !s.revokedAt);
  const isPromoted = keyData.allowedScopes.includes("env:live");

  async function rotateSecret() {
    if (!activeSecret) return;
    setRotating(true);
    try {
      const res = await fetch(`/api/api-keys/${keyData.clientId}/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          oldSecretId: activeSecret.id,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error("Failed to rotate", { description: err.error });
        return;
      }
      const result = await res.json();
      setRotatedSecret(result);
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to rotate: ${msg}`);
    } finally {
      setRotating(false);
    }
  }

  async function promote() {
    setPromoting(true);
    try {
      const res = await fetch(`/api/oauth-clients/${keyData.clientId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "promote" }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error("Failed to promote", { description: err.error });
        return;
      }
      toast.success("Key promoted to env:live");
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to promote: ${msg}`);
    } finally {
      setPromoting(false);
    }
  }

  async function updateCeiling() {
    try {
      const collections = newCeiling.trim() ? newCeiling.split(",").map(c => c.trim()) : null;
      const res = await fetch(`/api/api-keys/${keyData.clientId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowedCollections: collections }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error("Failed to update ceiling", { description: err.error });
        return;
      }
      toast.success("Collection ceiling updated");
      await onRefresh();
      setEditingCeiling(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to update ceiling: ${msg}`);
    }
  }

  async function revokeSecret(secretId: string, prefix: string) {
    try {
      const res = await fetch(`/api/api-keys/${keyData.clientId}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secretId }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error("Failed to revoke", { description: err.error });
        return;
      }
      toast.success(`Revoked ${prefix}`);
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to revoke: ${msg}`);
    }
  }

  if (showAudit) {
    return (
      <AuditBrowser
        via={keyData.clientId}
        backLabel={`Back to ${keyData.displayName}`}
        onBack={() => setShowAudit(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={onClose} className="mb-2 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft size={16} />Back to keys
          </button>
          <h1 className="text-2xl font-bold">{keyData.displayName}</h1>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4 rounded-lg border p-4">
          <div>
            <Label className="text-xs text-muted-foreground">Client ID</Label>
            <Mono copyable className="text-sm">{keyData.clientId}</Mono>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Mode</Label>
            <Badge variant="outline" className="font-mono text-xs mt-1">{keyData.mode}</Badge>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Environment</Label>
            <div className="flex flex-wrap gap-1 mt-1">
              {keyData.allowedScopes.map((scope) => (
                <Badge key={scope} variant="outline" className={cn(
                  "font-mono text-xs",
                  scope === "env:live" ? "text-allow" : undefined,
                )}>
                  {scope}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Created</Label>
            <p className="text-sm">{new Date(keyData.createdAt).toLocaleDateString()}</p>
          </div>
        </div>

        <div className="space-y-4 rounded-lg border p-4">
          <div>
            <Label className="text-xs text-muted-foreground">Collection ceiling</Label>
            {editingCeiling ? (
              <div className="space-y-2 mt-1">
                <Input
                  placeholder="documents, users (leave empty for no limit)"
                  value={newCeiling}
                  onChange={(e) => setNewCeiling(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={updateCeiling}>Save</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingCeiling(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div>
                {keyData.allowedCollections && keyData.allowedCollections.length > 0 ? (
                  <Mono className="text-sm">{`[${keyData.allowedCollections.join(", ")}]`}</Mono>
                ) : (
                  <p className="text-sm text-muted-foreground">No restrictions</p>
                )}
                <Button size="sm" variant="outline" onClick={() => setEditingCeiling(true)} className="mt-2">
                  Edit
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {activeSecret && (
        <div className="space-y-4 rounded-lg border p-4">
          <h3 className="font-semibold">Active secret</h3>
          <div className="grid gap-4 text-sm">
            <div>
              <Label className="text-xs text-muted-foreground">Prefix</Label>
              <Mono copyable className="text-sm">{activeSecret.prefix}</Mono>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground">Expires</Label>
                <p className="text-sm">{new Date(activeSecret.expiresAt).toLocaleDateString()}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Last used</Label>
                <p className="text-sm">
                  {activeSecret.lastUsedAt ? new Date(activeSecret.lastUsedAt).toLocaleDateString() : "Never"}
                </p>
              </div>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            {!isPromoted && (
              <Button size="sm" onClick={promote} disabled={promoting}>
                {promoting && <Loader2 size={14} className="mr-2 animate-spin" />}
                Promote to live
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline">Rotate secret</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Rotate secret?</AlertDialogTitle>
                  <AlertDialogDescription>
                    A new secret will be issued. The old secret continues working until you revoke it explicitly, giving you time to deploy the new one.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={rotateSecret} disabled={rotating}>
                    {rotating && <Loader2 size={14} className="mr-2 animate-spin" />}
                    Rotate
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive">Revoke</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revoke {activeSecret.prefix}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Revocation takes effect immediately on the very next API call — no token-expiry wait. Any caller using this secret will be rejected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive hover:bg-destructive/90"
                    onClick={() => revokeSecret(activeSecret.id, activeSecret.prefix)}
                  >
                    Revoke
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {keyData.secrets.length > 1 && (
        <div className="space-y-4 rounded-lg border p-4">
          <h3 className="font-semibold">Past secrets</h3>
          <div className="space-y-2">
            {keyData.secrets.filter(s => s.revokedAt).map((secret) => (
              <div key={secret.id} className="text-sm text-muted-foreground">
                <Mono>{secret.prefix}</Mono>
                <p className="text-xs">Revoked {new Date(secret.revokedAt!).toLocaleDateString()}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4 rounded-lg border p-4">
        <h3 className="font-semibold">API access audit</h3>
        <p className="text-sm text-muted-foreground">View all data access events triggered by this keyData.</p>
        <Button size="sm" variant="outline" onClick={() => setShowAudit(true)}>View audit trail</Button>
      </div>

      {rotatedSecret && (
        <Dialog open={!!rotatedSecret} onOpenChange={() => setRotatedSecret(null)}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Secret rotated</DialogTitle>
              <DialogDescription>
                Copy the new secret now — it is not stored in a form we can show you again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">New secret</Label>
                <Mono copyable className="text-sm font-bold">{rotatedSecret.secret}</Mono>
              </div>
              <p className="flex items-start gap-2 rounded-md border border-pending/40 p-3 text-xs text-muted-foreground">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-pending" />
                The old secret continues working. Revoke it after you deploy the new one.
              </p>
            </div>
            <DialogFooter><Button onClick={() => setRotatedSecret(null)}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
