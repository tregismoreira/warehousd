import type { NextRequest } from "next/server";
import { deriveRestContext } from "../../../lib/rest-context";
import { getBroker } from "../../lib/broker";
import { unauthenticated, ok } from "../../../lib/rest";

export async function GET(req: NextRequest) {
  const ctx = await deriveRestContext(req);
  if (!ctx) return unauthenticated();

  const collections = await getBroker().broker.listCollections(ctx);
  return ok(collections);
}
