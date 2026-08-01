import { vi } from "vitest";

/**
 * Captures `console.*` AND direct `process.stdout` / `process.stderr` writes.
 *
 * The probe harness used to spy on console.log and console.error alone. Next.js and Better Auth
 * write request logs and OAuth error responses straight to process.stdout, so a console-only spy
 * silently misses exactly the lines most likely to carry a request body — leaving the "or a log
 * line" half of invariant 4 unverified for the surfaces most able to break it.
 *
 * IMPORTANT: mocking process.stdout.write also swallows Vitest's own reporter output. Capture
 * around the assertion window only and always restore() in a finally — never mock for a whole
 * file in beforeAll, or a failure inside the window prints nothing and looks like a hang.
 */
// `String({a: 1})` is "[object Object]", and the broker logs its context as an object —
// `console.error("[broker] query failed", { collection, err })`. A capture that stringifies
// naively therefore greps "[object Object]" for a canary and never finds one, so the assertion
// passes whether or not the value leaked. Serialising is what makes the grep mean anything.
function render(value: unknown): string {
  if (typeof value === "string") return value;
  // Enumerable own properties too: a node-postgres error carries `detail`, `table` and `column`
  // beside the message, and those are the fields worth grepping.
  if (value instanceof Error) {
    const extra = JSON.stringify({ ...(value as unknown as object) });
    return `${value.name}: ${value.message} ${extra}\n${value.stack ?? ""}`;
  }
  try {
    return JSON.stringify(value, errorAwareReplacer) ?? String(value);
  } catch {
    return String(value);
  }
}

// JSON.stringify skips an Error's non-enumerable message and name, which is where a driver puts
// the text worth grepping.
function errorAwareReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(value as unknown as object) };
  }
  return value;
}

export function captureLogs() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(render).join(" "));
  };
  const write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  const spies = [
    vi.spyOn(console, "log").mockImplementation(push),
    vi.spyOn(console, "error").mockImplementation(push),
    vi.spyOn(console, "warn").mockImplementation(push),
    vi.spyOn(console, "info").mockImplementation(push),
    vi.spyOn(console, "debug").mockImplementation(push),
    vi.spyOn(process.stdout, "write").mockImplementation(write),
    vi.spyOn(process.stderr, "write").mockImplementation(write),
  ];

  return {
    lines,
    text: () => lines.join("\n"),
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}
