/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@warehousd/broker"],
  env: {
    NEXT_PUBLIC_WAREHOUSD_DEMO: process.env.WAREHOUSD_DEMO ?? "",
    NEXT_PUBLIC_LOCAL_LOGIN_DISABLED: process.env.SANDBOXD_DISABLE_LOCAL_LOGIN ?? "",
    NEXT_PUBLIC_BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8722",
  },
};
export default nextConfig;
