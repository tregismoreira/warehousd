import { headers } from "next/headers";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function Login() {
  // Read the demo flag per-request rather than inlining NEXT_PUBLIC_WAREHOUSD_DEMO at
  // build time: the published image is built once and configured at `warehousd start`,
  // so a baked-in value would be wrong for every consumer.
  //
  // `dynamic = "force-dynamic"` alone does not reliably opt this route out of Next's
  // Full Route Cache in this Next.js version (observed x-nextjs-cache: HIT serving a
  // build-time snapshot forever). Calling a real per-request API forces genuine dynamic
  // rendering. Local-login availability is resolved client-side via /api/sso/status.
  await headers();
  const demo = process.env.WAREHOUSD_DEMO === "true";

  return <LoginForm demo={demo} />;
}
