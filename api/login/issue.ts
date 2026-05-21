import type { IncomingMessage, ServerResponse } from "node:http";

import {
  issuePublisherToken,
  createNeonPublisherTokenStore,
  isTheFocusPublisherEmail,
} from "../../src/auth.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const body = await readBody(request);
  const email = (body as { email?: string }).email?.trim().toLowerCase();

  if (!email) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Email is required" }));
    return;
  }

  if (!isTheFocusPublisherEmail(email)) {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error:
          "Publishing is limited to verified email addresses ending exactly in @thefocus.ai.",
        email,
      }),
    );
    return;
  }

  const result = await issuePublisherToken({
    email,
    store: createNeonPublisherTokenStore(),
  });

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({ token: result.token, email: result.publisherEmail }),
  );
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    request.on("error", reject);
  });
}
