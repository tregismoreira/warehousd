// Exact match confirmation for destructive deploy operations. This is the only safety mechanism
// on an app that may hold real imported data, and unlike `stop --destroy` there is deliberately
// no --yes bypass. A near-miss (whitespace-padded, case-mismatched) must fail.
//
// The empty guard is not redundant with `typed === appName`. DeploySchema requires a non-empty
// app_name, but if one ever reaches here empty — an unset variable, a config read that failed
// open — a bare `===` would turn pressing Enter at the prompt into a confirmed destroy. An empty
// input is not a confirmation of anything, whatever it is compared against.
export function confirmDestroy(typed: string, appName: string): boolean {
  if (typed === "" || appName === "") return false;
  return typed === appName;
}
