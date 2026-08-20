import type { z } from "zod";

/**
 * A zod error as one readable line: `path: message`, semicolon-separated.
 *
 * ZodError's own `message` is `JSON.stringify(issues, null, 2)`, so anything that renders an error
 * on a single line — a CLI check, a log line, a refusal detail — gets the first character of a
 * serialised array and nothing else. Every caller that surfaces a zod failure to a person uses this.
 */
export function describeZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}
