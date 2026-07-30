// Rule 3 (§6.1): shown only when BOTH env:dev and env:live survived rules 1-2 for this
// client+user. This radio is a hint — /mcp/authorize's before-hook re-derives eligibility
// on resubmit and ignores any wh_env value outside {dev, live}. Default selection is dev.
export default async function EnvPickerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const params = new URLSearchParams(
    Object.entries(resolvedSearchParams).map(([k, v]) => [
      k,
      Array.isArray(v) ? (v[0] ?? "") : (v ?? ""),
    ]),
  );
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>Choose an environment</h1>
      <p>This app is requesting access. Pick which data environment to connect it to.</p>
      {/* GET form submission replaces the action URL's query entirely with the serialized
          form fields (HTML living standard) — the hidden inputs below carry every original
          param, so the action needs no query string of its own. */}
      <form action="/api/auth/mcp/authorize" method="GET">
        {Array.from(params.entries()).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label style={{ display: "block", marginBottom: 8 }}>
          <input type="radio" name="wh_env" value="dev" defaultChecked /> Development (synthetic
          data)
        </label>
        <label style={{ display: "block", marginBottom: 16 }}>
          <input type="radio" name="wh_env" value="live" /> Live (real data)
        </label>
        <button type="submit">Continue</button>
      </form>
    </main>
  );
}
