"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { requestJson } from "@/lib/client-api";
import { ApiKeysTable, type ApiKey } from "./ApiKeysTable";
import { NewApiKeyDialog } from "./NewApiKeyDialog";

export function AdminApiKeysHome() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const res = await requestJson<{ keys: ApiKey[] }>("/api/api-keys");
    if (res.ok) setKeys(res.data.keys);
    else toast.error(`Failed to load API keys: ${res.error}`);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader
        title="API keys"
        description="REST API credentials for programmatic access. Revocation takes effect immediately — no token-expiry wait."
        action={<NewApiKeyDialog onCreated={load} />}
      />
      <ApiKeysTable keys={keys} loading={loading} onRefresh={load} />
    </>
  );
}
