// Unauthenticated on purpose, same reasoning as /v1/openapi.json: this page only renders that
// document, and OAuth clients' developers need to read it before anyone holds a token.
import { ApiReference } from "@scalar/nextjs-api-reference";

export const GET = ApiReference({
  url: "/v1/openapi.json",
  pageTitle: "warehousd API reference",
  darkMode: true,
  forceDarkModeState: "dark",
});
