import { resolveProject } from "./project";
import { tryRun } from "./docker";
import { readOutputs, type Outputs } from "./state";

export type StatusResult = { healthy: boolean; outputs: Outputs | null };

export async function runStatus(dir: string): Promise<StatusResult> {
  const p = resolveProject(dir);
  const outputs = readOutputs(dir);

  // Check if any containers are running
  const listResult = tryRun(["ps", "-aq", "--filter", `label=${p.ns.label}`]);
  const hasContainers = listResult.ok && listResult.out.trim().length > 0;

  if (!hasContainers) {
    console.log("No containers running. Try: warehousd start");
    return { healthy: false, outputs: null };
  }

  // Try to health check against the API
  let healthy = false;
  if (outputs) {
    try {
      const url = new URL("/api/health", outputs.apiUrl);
      // `timeout` is not a RequestInit option, so this call had no timeout at all and a hung
      // server made `warehousd status` hang with it. AbortSignal.timeout is the real one, and the
      // abort surfaces as a rejection the catch below already handles.
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });
      healthy = response.ok;
    } catch {
      healthy = false;
    }
  }

  // Print outputs block
  if (outputs) {
    console.log("\nOutputs:");
    console.log(JSON.stringify(outputs, null, 2));
  }

  return { healthy, outputs };
}
