// One switch for `--verbose`, shared by both things this CLI shells out to.
//
// It started inside docker.ts, which meant `warehousd deploy --verbose` set a flag that nothing in
// the deploy path ever read — a deploy is almost entirely flyctl. A single module keeps the two
// from drifting into separate answers to the same question.

let verbose = false;

export function setVerbose(on: boolean): void {
  verbose = on;
}

export function isVerbose(): boolean {
  return verbose;
}

/** Echo of a command about to run, and of whatever it said on the way out. */
export function traceCommand(bin: string, args: string[]): void {
  if (verbose) process.stderr.write(`  $ ${bin} ${args.join(" ")}\n`);
}

export function traceFailure(detail: string): void {
  if (verbose && detail) process.stderr.write(`  ! ${detail}\n`);
}
