"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mono } from "@/components/common/Mono";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { requestJson } from "@/lib/client-api";
import type { Proposal } from "./ProposalsTable";

interface Document {
  [key: string]: unknown;
}

export function ProposalDetail({
  proposal,
  onClose,
  onRefresh,
}: {
  proposal: Proposal;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [proposed, setProposed] = useState<Document | null>(null);
  const [fieldsReturned, setFieldsReturned] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        // Two grant-checked reads, never one: the proposed values come from the pending
        // revision, the current ones from the live document. A `create` has no current
        // document at all — it is invisible until approved — so that read 404s by design.
        const [propRes, docRes] = await Promise.all([
          fetch(`/api/proposals/${proposal.proposalId}`),
          fetch(`/api/collections/${proposal.collection}/documents/${proposal.documentId}`),
        ]);

        if (propRes.ok) {
          const data = await propRes.json();
          setProposed(data.values);
          setFieldsReturned(data.fieldsReturned);
        } else if (propRes.status !== 403 && propRes.status !== 404) {
          throw new Error(`proposal ${propRes.status}`);
        }

        if (docRes.ok) {
          const data = await docRes.json();
          setDoc(data.document);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Failed to load proposal: ${msg}`);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [proposal]);

  async function handleApprove() {
    setActionInProgress(true);
    try {
      const res = await requestJson(`/api/proposals/${proposal.proposalId}/approve`, {
        method: "POST",
      });
      if (!res.ok) {
        toast.error("Failed to approve", { description: res.error });
        return;
      }
      toast.success("Proposal approved");
      await onRefresh();
      onClose();
    } finally {
      setActionInProgress(false);
    }
  }

  async function handleReject() {
    setActionInProgress(true);
    try {
      const res = await requestJson(`/api/proposals/${proposal.proposalId}/reject`, {
        method: "POST",
      });
      if (!res.ok) {
        toast.error("Failed to reject", { description: res.error });
        return;
      }
      toast.success("Proposal rejected");
      await onRefresh();
      onClose();
    } finally {
      setActionInProgress(false);
    }
  }

  const restrictedFields = proposal.fields.filter((f) => !fieldsReturned.includes(f));

  return (
    <div className="space-y-6 pb-8">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-2">
          <ChevronLeft size={16} />
          Back
        </Button>
        <div className="flex gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={actionInProgress}>
                {actionInProgress && <Loader2 size={16} className="mr-2 animate-spin" />}
                Reject
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reject proposal?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. The proposal will be marked as rejected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleReject}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Reject
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button disabled={actionInProgress}>
                {actionInProgress && <Loader2 size={16} className="mr-2 animate-spin" />}
                Approve
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Approve proposal?</AlertDialogTitle>
                <AlertDialogDescription>
                  The {proposal.op} operation on {proposal.collection} will be applied immediately.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleApprove}>Approve</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-3">Proposal metadata</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Collection</div>
              <Mono className="text-sm mt-1">{proposal.collection}</Mono>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Operation</div>
              <Badge variant="outline" className="font-mono text-xs mt-1">
                {proposal.op}
              </Badge>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Proposed by</div>
              <Mono className="text-sm mt-1">{proposal.proposedBy}</Mono>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Created</div>
              <div className="text-sm mt-1">{new Date(proposal.proposedAt).toLocaleString()}</div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-3">Fields affected</h3>
          {proposal.fields.length === 0 ? (
            <div className="text-sm text-muted-foreground">—</div>
          ) : (
            <div className="space-y-2">
              {proposal.fields.map((field) => {
                const isRestricted = restrictedFields.includes(field);
                return (
                  <div key={field} className="flex items-start justify-between text-sm">
                    <Mono>{field}</Mono>
                    {isRestricted && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock size={14} />
                        Restricted
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {loading ? (
          <div className="rounded-lg border p-8 flex items-center justify-center">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold mb-3">
              {doc ? "Proposed change" : "Proposed content"}
            </h3>
            <div className="space-y-3">
              {proposal.fields.map((field) => {
                const hasAccess = fieldsReturned.includes(field);
                const render = (v: unknown) =>
                  typeof v === "string" ? v : JSON.stringify(v, null, 2);
                return (
                  <div key={field} className="border-t pt-3 last:border-t-0 last:pt-0">
                    <div className="text-xs text-muted-foreground mb-1 flex items-center justify-between">
                      <span>{field}</span>
                      {!hasAccess && (
                        <span className="flex items-center gap-1 text-xs text-pending font-medium">
                          <Lock size={12} />
                          Not readable by you
                        </span>
                      )}
                    </div>
                    {hasAccess ? (
                      <div className="grid gap-2 md:grid-cols-2">
                        {doc && (
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Current</div>
                            <Mono className="text-sm break-words text-muted-foreground">
                              {render(doc[field])}
                            </Mono>
                          </div>
                        )}
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">Proposed</div>
                          <Mono className="text-sm break-words">
                            {proposed ? render(proposed[field]) : "—"}
                          </Mono>
                        </div>
                      </div>
                    ) : (
                      // Present-but-unreadable: the reviewer learns the field changed, never
                      // what it changed to.
                      <div className="text-sm text-muted-foreground italic">—</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
