import { it, expect } from "vitest";
import { captureLogs } from "./log-capture";

// A canary assertion against a capture that quietly caught nothing passes for the wrong reason,
// and would report "no leak" for a leak it never saw. These prove the helper is wired to the
// streams it claims — the whole point of it over the console-only spy it replaced.
it("captures console.* and raw stdout/stderr writes, then restores them", () => {
  const capture = captureLogs();
  try {
    console.log("via-console-log");
    console.error("via-console-error");
    process.stdout.write("via-stdout-write");
    process.stderr.write("via-stderr-write");
  } finally {
    capture.restore();
  }

  const text = capture.text();
  expect(text).toContain("via-console-log");
  expect(text).toContain("via-console-error");
  expect(text).toContain("via-stdout-write");
  expect(text).toContain("via-stderr-write");
});

// The failure mode this guards: the broker logs its context as an object, and `String(obj)` is
// "[object Object]". A capture that renders that way greps for a canary in a string that could
// never contain one, so every "no leak" assertion built on it passes vacuously.
it("serialises object and Error arguments instead of rendering [object Object]", () => {
  const capture = captureLogs();
  try {
    console.error("[broker] query failed", { collection: "people", secret: "CANARY_VALUE_X" });
    console.error(
      "with an error",
      Object.assign(new Error("boom"), { detail: "CANARY_IN_DETAIL" }),
    );
  } finally {
    capture.restore();
  }

  const text = capture.text();
  expect(text).not.toContain("[object Object]");
  expect(text).toContain("CANARY_VALUE_X");
  expect(text).toContain("boom");
  expect(text).toContain("CANARY_IN_DETAIL");
});

it("stops capturing after restore", () => {
  const capture = captureLogs();
  capture.restore();
  process.stdout.write("");
  console.log("");
  expect(capture.lines.filter(Boolean)).toEqual([]);
});
