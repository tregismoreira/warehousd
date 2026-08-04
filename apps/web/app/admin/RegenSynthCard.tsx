"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

export function RegenSynthCard() {
  const [seed, setSeed] = useState("42");
  const [loading, setLoading] = useState(false);

  async function regenerate() {
    setLoading(true);
    try {
      const seedNum = seed === "" ? 42 : parseInt(seed, 10);
      if (!Number.isFinite(seedNum)) {
        toast.error("Invalid seed", { description: "Seed must be a valid number" });
        return;
      }
      const res = await requestJson<{ collections: string[] }>("/api/admin/regen-synth", {
        method: "POST",
        body: JSON.stringify({ seed: seedNum }),
      });
      if (!res.ok) {
        toast.error("Failed to regenerate", { description: res.error });
        return;
      }
      toast.success(`Regenerated ${res.data.collections.length} collections`, {
        description: res.data.collections.join(", "),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regenerate Synthetic Data</CardTitle>
        <CardDescription>
          Synthetic data is generated from the schema alone — never sampled from real data.
          Regenerating discards every row in{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">data_synth</code> and rebuilds it
          from the seed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Input
            type="number"
            placeholder="42"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className="w-32"
            disabled={loading}
          />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button disabled={loading}>
                {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
                Regenerate
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate synthetic data?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every synthetic row is discarded and rebuilt. Grants, audit history and live data
                  are untouched.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive hover:bg-destructive/90"
                  onClick={regenerate}
                  disabled={loading}
                >
                  {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
                  Regenerate
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
