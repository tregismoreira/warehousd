"use client";
import { useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
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
import { Mono } from "@/components/common/Mono";

export function NewClientDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ clientId: string; clientSecret: string } | null>(null);

  async function submit() {
    const res = await fetch("/api/oauth-clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      setCreated(await res.json());
      onCreated();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setCreated(null);
          setName("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus size={16} className="mr-2" />
          New client
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Client created</DialogTitle>
              <DialogDescription>
                Copy the secret now — it is not stored in a form we can show you again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Client ID</Label>
                <Mono copyable className="text-sm">
                  {created.clientId}
                </Mono>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Client secret</Label>
                <Mono copyable className="text-sm">
                  {created.clientSecret}
                </Mono>
              </div>
              <p className="flex items-start gap-2 rounded-md border border-pending/40 p-3 text-xs text-muted-foreground">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-pending" />
                This client is scoped to <b className="mx-1 font-mono">env:dev</b> and can only ever
                receive synthetic data. Build against it, then ask a manager to promote it — no new
                credentials are needed.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New client</DialogTitle>
              <DialogDescription>
                For an app you are building against warehousd. Claude and other MCP clients register
                themselves and do not need this.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                placeholder="Quarterly reporting app"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!name.trim()} onClick={submit}>
                Create
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
