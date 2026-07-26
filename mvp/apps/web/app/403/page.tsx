import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Forbidden() {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-full bg-muted p-3"><ShieldAlert size={24} className="text-deny" /></div>
      <h1 className="text-xl font-semibold">You don&rsquo;t have access to this area</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        This surface is restricted by role. If you believe you should have access, ask an
        administrator to change your role.
      </p>
      <Button asChild variant="outline"><Link href="/">Back to your workspace</Link></Button>
    </main>
  );
}
