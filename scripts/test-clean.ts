// Drop this checkout's leftover test databases by hand.
//
// The least important of 5.4.1's four parts, and deliberately so: a cleanup command nobody
// remembers to run is how the leak reached 211 databases and 1.68 GB in the first place. The
// sweeps in vitest.global-setup.ts are what actually keep it collected; this is for the case where
// you want the space back now without starting a run.
//
// Scoped to this checkout's suffix and skipping live pids, exactly like the automatic sweeps — a
// sibling Conductor workspace mid-run is not something a cleanup command may touch.
import { dropStaleClones } from "../packages/broker/test/helpers/templates";

const dropped = await dropStaleClones();
console.log(
  dropped
    ? `dropped ${dropped} leftover test database(s)`
    : "no leftover test databases for this checkout",
);
