import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { loadConfig } from "@warehousd/broker";
import { join } from "node:path";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get("collection") ?? "";
  const env = req.nextUrl.searchParams.get("env") ?? "dev";

  // Validate inputs
  if (env !== "dev" && env !== "live") {
    return Response.json({ error: "Invalid env" }, { status: 400 });
  }

  const cfg = loadConfig(projectDir);
  const collCfg = cfg.collections[collection];
  if (!collCfg || collCfg.type !== "file") {
    return Response.json({ error: "Collection not found or not a file collection" }, { status: 400 });
  }

  const app = getAppPool();
  const schema = env === "dev" ? "data_synth" : "data_live";
  // collection is validated above against the loaded config's file-type collections,
  // so this identifier interpolation is safe (SQL identifiers can't be parameterized).
  const tableName = `${collection}__files`;

  try {
    const result = await app.query(
      `select path from ${schema}."${tableName}" order by path`,
    );
    return Response.json({ paths: result.rows.map(r => r.path) });
  } catch (err) {
    return Response.json({ error: "Failed to query file paths" }, { status: 500 });
  }
}
