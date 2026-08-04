"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { requestJson } from "@/lib/client-api";

// No confirmation dialog, unlike regenerating synthetic data: this only ever fills embeddings
// that are missing. Pressing it twice costs nothing and it destroys nothing, so a dialog would
// be ceremony over an action with no downside.
export function EmbedCard() {
  const [env, setEnv] = useState<"dev" | "live">("live");
  const [loading, setLoading] = useState(false);

  async function embed() {
    setLoading(true);
    try {
      const res = await requestJson<{ embedded: number; collections: string[] }>(
        "/api/admin/embed",
        { method: "POST", body: JSON.stringify({ env }) },
      );
      if (!res.ok) {
        toast.error(
          res.error === "embedding_not_configured"
            ? "No embedding: block in warehousd.yml"
            : "Failed to embed",
          {
            description:
              res.error === "embedding_not_configured"
                ? "Semantic and hybrid search need a model configured before anything can be embedded."
                : res.error,
          },
        );
        return;
      }
      toast.success(
        res.data.embedded === 0
          ? "Nothing left to embed"
          : `Embedded ${res.data.embedded} document(s)`,
        { description: res.data.collections.join(", ") },
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Embed documents</CardTitle>
        <CardDescription>
          Fills the embedding column for every file collection, so <code>search_documents</code> can
          answer <code>semantic</code> and <code>hybrid</code>. Only chunks that have none are
          touched, so this is safe to re-run and cheap to resume after an interrupted pass.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Select value={env} onValueChange={(v) => setEnv(v as "dev" | "live")}>
            <SelectTrigger className="w-32" disabled={loading}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">live</SelectItem>
              <SelectItem value="dev">dev</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={embed} disabled={loading}>
            {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
            Embed
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
