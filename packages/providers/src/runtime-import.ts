// A dynamic import the bundler cannot follow.
//
// `packages/cli` builds to a single CommonJS bundle with `noExternal: [/.*/]`, and esbuild
// resolves a literal `await import("x")` at build time — inlining the dependency regardless of
// the `external` list, which is only consulted for statically-imported specifiers.
//
// For one dependency here that is fatal: @huggingface/transformers is ESM-only, so the CommonJS
// rewrite produces a bundle that cannot load it at all — and drags several megabytes of ONNX
// runtime and platform-specific `.node` binaries in on the way.
//
// unpdf and mammoth deliberately do NOT go through this: both resolve under CommonJS, so a plain
// static import works in every environment, and routing them through here bought a smaller CLI
// bundle at the cost of a resolution path that failed under vitest.

// Going through `new Function` leaves the specifier opaque to any bundler while keeping a genuine
// runtime `import()`, which Node supports from CommonJS. Every caller already handles the reject
// path by reporting the capability as unavailable, so a deployment that did not install one of
// these gets a clear message rather than a module-resolution stack trace.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// no-implied-eval is right to flag `new Function`, and this is the narrow case it does not cover:
// the body is a fixed literal written here, never built from input, and the only thing that varies
// is the specifier — which comes from one call site in this package and nowhere else. Nothing
// caller-supplied reaches it.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const opaqueImport = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;

/**
 * Import an optional dependency by name, without the bundler seeing it.
 *
 * The specifier is resolved against THIS module before being handed over. A function built by
 * `new Function` has no referrer, so a bare specifier inside it resolves relative to the process
 * rather than to this package — which happens to work from a bundled CLI and fails under vitest
 * and under Next, where the dependency lives in a nested node_modules. Resolving first turns it
 * into an absolute URL, which needs no referrer at all.
 */
export async function importRuntime<T = unknown>(spec: string): Promise<T> {
  for (const target of candidates(spec)) {
    try {
      return (await opaqueImport(target)) as T;
    } catch {
      /* try the next form */
    }
  }
  // Every form failed: the dependency is genuinely not installed. Let the last attempt's error
  // reach the caller, which turns it into "X support is not installed".
  return (await opaqueImport(spec)) as T;
}

// The specifier forms to try, most-resolvable first.
//
// Three environments have to work and they disagree about what a referrer-less `import()` can
// resolve: the bundled CommonJS CLI, vitest (which transforms this module and does not always
// provide `import.meta.resolve`), and Next. Resolving to an absolute file URL first sidesteps the
// disagreement — an absolute URL needs no referrer — and the bare specifier remains as a last
// resort for wherever the process root can already see the package.
function* candidates(spec: string): Generator<string> {
  try {
    // ESM resolution: honours `exports`, and is the only one that finds an ESM-only package.
    yield import.meta.resolve(spec);
  } catch {
    /* not available, or not resolvable this way */
  }
  try {
    // CommonJS resolution, for packages whose `exports` carry a `require` condition. Reached
    // under vitest, where import.meta.resolve is not reliably present.
    const req = createRequire(import.meta.url);
    yield pathToFileURL(req.resolve(spec)).href;
  } catch {
    /* not resolvable this way either */
  }
  yield spec;
}
