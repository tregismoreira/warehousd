"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { ClientsTable, type Client } from "./ClientsTable";
import { NewClientDialog } from "./NewClientDialog";

export function AdminClientsHome() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oauth-clients");
      const data = await res.json();
      setClients(data.clients);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to load clients: ${msg}`);
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
        title="OAuth clients"
        description="User-built apps accessing warehousd data. Promotion to live is a manager&rsquo;s gate on data sensitivity."
        action={<NewClientDialog onCreated={load} />}
      />
      <ClientsTable clients={clients} loading={loading} onRefresh={load} />
    </>
  );
}
