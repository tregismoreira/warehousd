/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@warehousd/broker"],
  // No `env:` block on purpose. Next inlines these at build time, but the published image is
  // built once and configured per-consumer at `warehousd start`, so anything baked in here is
  // wrong for everyone. The demo flag is read per-request in app/login/page.tsx, the auth
  // client is same-origin, and local-login availability comes from /api/sso/status.
};
export default nextConfig;
