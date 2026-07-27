import { headers } from "next/headers";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function Login() {
  // `dynamic = "force-dynamic"` alone does not reliably opt this route out of
  // Next's Full Route Cache in this Next.js version (observed x-nextjs-cache: HIT
  // serving a build-time snapshot of WAREHOUSD_DEMO forever). Calling a real
  // per-request API forces genuine dynamic rendering so the env var is read fresh
  // on every request, which is the whole point of Task 4's runtime-config work.
  await headers();
  const demo = process.env.WAREHOUSD_DEMO === "true";
  const disabled = process.env.SANDBOXD_DISABLE_LOCAL_LOGIN === "true";

  return <LoginForm demo={demo} disabled={disabled} />;
}
