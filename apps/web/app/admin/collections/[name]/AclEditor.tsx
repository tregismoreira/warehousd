"use client";
import { useState } from "react";
import { Loader2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";

type Acl = {
  collection: string;
  documentId: string;
  principals: string[];
  updatedAt: string | null;
  updatedBy: string | null;
};

/**
 * Read and edit one document's ACL.
 *
 * The rule this edits is short enough to state on the page, and it is stated there: a document
 * with no principals is readable by anyone the grant covers; a document with principals is
 * readable only by them. Nothing here narrows a grant — an ACL cannot give somebody access their
 * grant does not already carry, it can only take an individual document out of it.
 *
 * Every read and every write goes through the broker and writes an audit row, exactly as the data
 * browser's queries do. There is no console-only path to an ACL.
 */
export function AclEditor({ collection }: { collection: string }) {
  const [documentId, setDocumentId] = useState("");
  const [acl, setAcl] = useState<Acl | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [kind, setKind] = useState<"user" | "group">("user");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/admin/collections/${encodeURIComponent(collection)}/acl`;

  async function load() {
    const id = documentId.trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}?id=${encodeURIComponent(id)}`);
      const body = await res.json();
      if (!res.ok) {
        setAcl(null);
        setError(String(body.error ?? `HTTP ${res.status}`));
        return;
      }
      setAcl(body.acl);
      setGroups(body.groups ?? []);
    } catch {
      setError("internal_error");
    } finally {
      setLoading(false);
    }
  }

  // One writer for add and remove alike: an ACL is a set, and both operations are "store this
  // set". Two endpoints would be two chances for the console's idea of the set and the database's
  // to diverge.
  async function save(principals: string[]) {
    const id = documentId.trim();
    if (!id) return;
    setSaving(true);
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, principals }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error("ACL not saved", { description: String(body.error ?? `HTTP ${res.status}`) });
        return;
      }
      setAcl(body.acl);
      toast.success(
        principals.length ? "Restricted to the listed principals" : "Document is public again",
      );
    } catch {
      toast.error("ACL not saved", { description: "internal_error" });
    } finally {
      setSaving(false);
    }
  }

  function add() {
    const value = name.trim();
    if (!value || !acl) return;
    const principal = `${kind}:${value}`;
    if (acl.principals.includes(principal)) return;
    setName("");
    void save([...acl.principals, principal]);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground italic">
        A document with no principals is readable by anyone whose grant covers this collection. A
        document with principals is readable only by those principals — through every verb, and in
        every aggregate: a <Mono>count</Mono> over this collection counts what the caller may see.
        An ACL never widens a grant; it only takes one document out of it.
      </p>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
        <div className="space-y-2">
          <Label htmlFor="acl-doc-id">Document id</Label>
          <Input
            id="acl-doc-id"
            placeholder="Primary key value"
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void load()}
            className="w-80"
          />
        </div>
        <Button onClick={() => void load()} disabled={loading || !documentId.trim()}>
          {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
          Load ACL
        </Button>
      </div>

      {error && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-deny/30 bg-deny/5 p-3 text-sm">
          <Badge variant="outline" className="font-mono text-xs text-deny">
            {error}
          </Badge>
          <span className="text-muted-foreground">
            {error === "acl_denied"
              ? "Managing ACLs takes the manager or admin role."
              : error === "invalid_intent"
                ? "This collection does not declare acl: true in warehousd.yml."
                : "The broker refused that request."}
          </span>
        </div>
      )}

      {acl && (
        <div className="space-y-4">
          {acl.principals.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="Public within the grant"
              description="No ACL row for this document, so anyone whose grant covers this collection can read it."
            />
          ) : (
            <div className="space-y-2">
              <Label>Principals</Label>
              <div className="flex flex-wrap gap-2">
                {acl.principals.map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs"
                  >
                    {p}
                    <button
                      type="button"
                      aria-label={`Remove ${p}`}
                      disabled={saving}
                      onClick={() => void save(acl.principals.filter((x) => x !== p))}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {acl.updatedAt && (
                  <>
                    Last changed {new Date(acl.updatedAt).toLocaleString()}
                    {acl.updatedBy && (
                      <>
                        {" "}
                        by <Mono>{acl.updatedBy}</Mono>
                      </>
                    )}
                  </>
                )}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
            <div className="space-y-2">
              <Label htmlFor="acl-kind">Principal</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as "user" | "group")}>
                <SelectTrigger id="acl-kind" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="group">group</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="acl-name">{kind === "user" ? "User id" : "Group name"}</Label>
              {/* Groups are warehousd's own record (app.user_groups), synced from the IdP or
                  pinned in the console — never read from a token. A free-text field is offered
                  alongside the known list because a group can be added before anyone is in it. */}
              <Input
                id="acl-name"
                list={kind === "group" ? "acl-known-groups" : undefined}
                placeholder={kind === "user" ? "user id" : "group name"}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
                className="w-72"
              />
              {kind === "group" && (
                <datalist id="acl-known-groups">
                  {groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              )}
            </div>
            <Button variant="outline" onClick={add} disabled={saving || !name.trim()}>
              {saving ? (
                <Loader2 size={16} className="mr-2 animate-spin" />
              ) : (
                <UserPlus size={16} className="mr-2" />
              )}
              Add
            </Button>
            {acl.principals.length > 0 && (
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => void save([])}
                className="text-destructive"
              >
                Make public
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
