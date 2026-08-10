import { useProject } from "./project";
import { psByLabel, type ContainerRow } from "./docker";
import { readOutputs, type Outputs } from "./state";

export type StatusResult = {
  healthy: boolean;
  outputs: Outputs | null;
  containers: ContainerRow[];
  project: string;
};

// Reports; it no longer prints. `status` used to `console.log(JSON.stringify(outputs, null, 2))`
// straight at the user — which was simultaneously the wrong thing for a human to read and not
// reachable by a script, since it came wrapped in prose. Rendering now happens in index.ts, from
// this result, in whichever of the two forms was asked for.
export async function runStatus(dir: string): Promise<StatusResult> {
  const p = useProject(dir);
  const outputs = readOutputs(dir);
  const containers = psByLabel(p.ns.label);

  if (containers.length === 0) {
    return { healthy: false, outputs: null, containers, project: p.name };
  }

  // outputs.json is written by `start`, so it can legitimately be missing while the stack is up:
  // a checkout that was cloned after the containers were created, or a `stop --destroy` that took
  // the file but not the containers. Reporting "not responding" in that case would blame the
  // server for a missing local file, so fall back to the port the config already declares.
  const apiUrl = outputs?.apiUrl ?? `http://localhost:${p.ports.server}`;

  let healthy: boolean;
  try {
    const url = new URL("/api/health", apiUrl);
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

  return { healthy, outputs, containers, project: p.name };
}
