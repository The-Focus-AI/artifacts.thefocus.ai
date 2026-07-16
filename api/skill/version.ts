import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * Skill install metadata for agents.
 * Mirrors here.now's /api/skill/version discovery endpoint.
 */
export default async function handler(
  _request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readFile(
    join(process.cwd(), "public", "skill-version.json"),
    "utf8",
  );

  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=60");
  response.setHeader("Content-Signal", "ai-train=no, search=yes, ai-input=yes");
  response.end(body);
}
