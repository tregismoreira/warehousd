import LoginForm from "./LoginForm";

export default function Login() {
  const demo = process.env.WAREHOUSD_DEMO === "true";
  const disabled = process.env.SANDBOXD_DISABLE_LOCAL_LOGIN === "true";

  return <LoginForm demo={demo} disabled={disabled} />;
}
