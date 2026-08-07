"use client";
import { useEffect, useState } from "react";
import { Mono } from "@/components/common/Mono";
import { requestJson } from "@/lib/client-api";

// §P5's console half: the effective-access matrix, rendered from `explainAccess`.
//
// One component for all three places the plan names — the approve sheet, the admin user detail
// page, and a member's own page — because they are the same question asked by three different
// people, and three renderings of it would be three chances to describe the policy differently.
//
// Nothing here is a field value. The broker returns the shape of a policy (verbs/explain.ts), and
// that is what makes it safe to put on a page.

type FieldExplanation = {
  field: string;
  posture: "allow" | "mask" | "deny";
  grantable: boolean;
  granted: boolean;
  effect: "raw" | "masked" | "none";
  unmaskable: boolean;
  unmasked: boolean;
  writable: boolean;
  blockedBy: "posture" | "no_grant" | "not_in_grant" | "masked" | null;
};

export type AccessExplanation = {
  collection: string;
  subject: string;
  grant: {
    id: string;
    principal: string;
    verbs: string[];
    mode: string;
    expiresAt: string | null;
    via: string[];
  } | null;
  fields: FieldExplanation[];
  matchedDocuments: number | null;
};

// The whole point of the verb, in words: "denied", "not in your grant" and "masked" are three
// different problems, and the person who can fix each of them is different.
const WHY: Record<NonNullable<FieldExplanation["blockedBy"]>, string> = {
  posture: "the config denies it — no grant can ever carry it",
  no_grant: "there is no approved grant on this collection",
  not_in_grant: "the grant does not carry this field",
  masked: "the grant carries it, transformed",
};

const EFFECT_LABEL: Record<FieldExplanation["effect"], string> = {
  raw: "the stored value",
  masked: "a transformed value",
  none: "nothing",
};

export function AccessExplainer({
  collection,
  subject,
  /** Refetch when this changes — the approve sheet passes the fields it is about to grant. */
  refreshKey,
}: {
  collection: string;
  subject?: string | undefined;
  refreshKey?: string | number | undefined;
}) {
  const [data, setData] = useState<AccessExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const q = new URLSearchParams({ collection });
      if (subject) q.set("subject", subject);
      const res = await requestJson<AccessExplanation>(`/api/access?${q.toString()}`);
      if (cancelled) return;
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setData(null);
        setError(res.error);
      }
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [collection, subject, refreshKey]);

  if (loading) return <p className="text-xs text-muted-foreground">Working out access…</p>;
  if (error)
    return (
      <p className="text-xs text-muted-foreground">
        {error === "not_authorized"
          ? "Only a manager can see somebody else's access."
          : `Could not explain access: ${error}`}
      </p>
    );
  if (!data) return null;

  const inherited = data.grant?.principal.startsWith("group:") ?? false;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {data.grant ? (
          <>
            Deciding grant:{" "}
            <Mono>{data.grant.principal.slice(data.grant.principal.indexOf(":") + 1)}</Mono>{" "}
            {inherited ? "(inherited from this group)" : "(personal)"} ·{" "}
            {data.grant.verbs.join(", ")}
            {data.grant.expiresAt
              ? ` · expires ${new Date(data.grant.expiresAt).toLocaleDateString()}`
              : " · no expiry"}
            {data.matchedDocuments !== null && (
              <> · reaches {data.matchedDocuments.toLocaleString()} document(s)</>
            )}
          </>
        ) : (
          <>No approved grant on {data.collection}.</>
        )}
      </p>
      {inherited && data.grant && (
        <p className="text-xs text-muted-foreground">
          A personal grant would take precedence over this one — including a narrower one, which
          would reduce access.
        </p>
      )}
      <div className="overflow-auto rounded border">
        <table className="w-full text-xs">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">Field</th>
              <th className="p-2 font-medium">Config</th>
              <th className="p-2 font-medium">Sees</th>
              <th className="p-2 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {data.fields.map((f) => (
              <tr key={f.field} className="border-b last:border-0">
                <td className="p-2 font-mono">{f.field}</td>
                <td className="p-2">
                  <Mono
                    className={
                      f.posture === "deny"
                        ? "text-deny"
                        : f.posture === "mask"
                          ? "text-muted-foreground"
                          : "text-allow"
                    }
                  >
                    {f.posture}
                  </Mono>
                  {f.unmaskable && <span className="ml-1 text-muted-foreground">· unmaskable</span>}
                </td>
                <td className="p-2">{EFFECT_LABEL[f.effect]}</td>
                <td className="p-2 text-muted-foreground">
                  {f.blockedBy ? WHY[f.blockedBy] : "granted in full"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
