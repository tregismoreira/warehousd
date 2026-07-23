// Rule 3 (§6.1): shown only when BOTH env:dev and env:live survived rules 1-2 for this
// client+user. This radio is a hint — /mcp/authorize's before-hook re-derives eligibility
// on resubmit and ignores any wh_env value outside {dev, live}. Default selection is dev.
export default function EnvPickerPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const params = new URLSearchParams(
    Object.entries(searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] ?? "" : v ?? ""]),
  );
  const authorizeAction = `/api/auth/mcp/authorize?${params.toString()}`;

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>Choose an environment</h1>
      <p>This app is requesting access. Pick which data environment to connect it to.</p>
      <form action={authorizeAction} method="GET">
        {Array.from(params.entries()).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label style={{ display: "block", marginBottom: 8 }}>
          <input type="radio" name="wh_env" value="dev" defaultChecked /> Development (synthetic data)
        </label>
        <label style={{ display: "block", marginBottom: 16 }}>
          <input type="radio" name="wh_env" value="live" /> Live (real data)
        </label>
        <button type="submit">Continue</button>
      </form>
    </main>
  );
}
