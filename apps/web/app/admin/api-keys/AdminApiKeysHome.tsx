"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { ApiKeysTable, type ApiKey } from "./ApiKeysTable";
import { NewApiKeyDialog } from "./NewApiKeyDialog";

export function AdminApiKeysHome() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/api-keys");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setKeys(data.keys);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to load API keys: ${msg}`);
    } finally {
      setLoading(false);
    }
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
