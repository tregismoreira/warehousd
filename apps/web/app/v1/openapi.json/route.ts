// Unauthenticated on purpose. This document describes the shape of the API — never a collection
// name, a field name, or a document. Everything it names is already public in the repository,
// and OAuth clients need it before they hold a token. `middleware.ts`'s matcher does not cover
// /v1, so nothing gates this by accident.
import spec from "../../../../../docs/openapi.json";

export function GET() {
  return Response.json(spec, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
