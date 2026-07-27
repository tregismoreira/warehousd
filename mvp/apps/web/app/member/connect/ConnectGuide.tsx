"use client";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Mono } from "@/components/common/Mono";
import { Skeleton } from "@/components/ui/skeleton";

type Info = { mcpUrl: string; scopes: string[]; ssoProviders: { providerId: string }[] };

export function ConnectGuide() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => { fetch("/api/connect-info").then((r) => r.json()).then(setInfo); }, []);
  if (!info) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-sm font-medium">Your MCP endpoint</CardTitle></CardHeader>
        <CardContent>
          <Mono copyable className="text-sm">{info.mcpUrl}</Mono>
          <p className="mt-2 text-sm text-muted-foreground">
            Paste this into Claude&rsquo;s connector settings. Authentication happens over
            OAuth — you never enter a password or a token here.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm font-medium">Steps</CardTitle></CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>In Claude, open <b>Settings → Connectors → Add custom connector</b>.</li>
            <li>Paste the endpoint above and continue.</li>
            <li>
              You&rsquo;ll be sent here to sign in
              {info.ssoProviders.length > 0
                ? " with your organisation account."
                : " with your warehousd credentials."}
            </li>
            <li>
              Approve the connection. If you have approved live grants you&rsquo;ll be asked to
              pick an environment — <Mono>dev</Mono> uses synthetic data, <Mono>live</Mono> uses
              real data.
            </li>
            <li>
              Ask Claude to <i>list the collections it can see</i>. Anything you have no grant
              for stays invisible.
            </li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm font-medium">What Claude can and cannot do</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Claude proposes queries; the broker re-validates every one of them against your
            grants before any SQL is built. Fields you have no grant for are never selected,
            so they cannot appear in an answer — not even in an error message.
          </p>
          <p>
            Every call, allowed or refused, is written to the audit log with your identity,
            the environment, and the purpose on your grant.
          </p>
          <p>Claude cannot write, update or delete anything. The MCP surface is read plus access-request only.</p>
        </CardContent>
      </Card>
    </div>
  );
}
