// Refuses to start the e2e dev server when its port is already taken.
//
// `next dev -p N` does not fail on a busy port — it prints a notice and binds N+1. Playwright
// would then spend its 600s startup budget polling an origin nothing of ours is serving, or, if
// another checkout's app is what answers there, run the whole suite against that app and its
// database and report the result as this workspace's. Fail here instead, with the command that
// names the culprit.
import { createServer } from "node:net";

const port = Number(process.env.WAREHOUSD_APP_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("assert-port-free: WAREHOUSD_APP_PORT is unset or not a port number");
  process.exit(1);
}

// No host, so this binds the wildcard address the same way `next dev` does — a probe bound only
// to 127.0.0.1 would miss a squatter holding another interface.
const probe = createServer();

probe.once("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${port} is already in use, so the e2e dev server cannot bind it.\n` +
        `Most likely another workspace's suite, or a stray \`next dev\`:\n\n` +
        `    lsof -nP -iTCP:${port} -sTCP:LISTEN\n\n` +
        `Free it, or run this suite elsewhere with WAREHOUSD_E2E_PORT.\n`,
    );
  } else {
    console.error(`assert-port-free: ${err.message}`);
  }
  process.exit(1);
});

probe.once("listening", () => probe.close(() => process.exit(0)));
probe.listen(port);
