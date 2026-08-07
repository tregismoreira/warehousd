import { progressDetail, type Progress, type Reporter, type StepHandle } from "./reporter";

// The bridge between a broker operation's `onProgress` and a live reporter step.
//
// Every long operation in the broker reports progress in the same `{ done, total? }` shape, and
// every one of them is narrated the same way, so the translation belongs in one place rather than
// at each of the five call sites. `step.update` already throttles and already no-ops off a TTY —
// see StepHandle.update — so a caller here never has to think about either.

export type Tracked<P> = {
  step: StepHandle;
  onProgress: (p: P) => void;
};

/**
 * Start a step and hand back the `onProgress` for it.
 *
 * `map` exists because the five operations do not all report the same object: `EmbedProgress` is
 * `{ embedded, remaining }` and predates the convention, `IndexProgress` and `ImportProgress`
 * carry a `phase`. Rather than change three published shapes, each is mapped at its call site —
 * one adapter, next to the thing it adapts.
 */
export function trackStepWith<P>(
  reporter: Reporter,
  verb: string,
  label: string,
  map: (p: P) => Progress,
  now: () => number = () => Date.now(),
): Tracked<P> {
  const step = reporter.step(verb, label);
  const started = now();
  return {
    step,
    onProgress: (p: P) => step.update(progressDetail(map(p), now() - started)),
  };
}
