import type { IncomingMessage, ServerResponse } from "node:http";

import { buildClerkSignInUrl } from "../src/auth-clerk.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = requestToUrl(request);
  const port = url.searchParams.get("port") ?? "";

  const callbackUrl = new URL(
    port ? `/login/callback?port=${port}` : `/login/callback`,
    `${url.protocol}//${url.host}`,
  );
  const signInUrl = buildClerkSignInUrl(callbackUrl.toString());

  // Set a cookie to preserve the port across the Clerk redirect chain
  const headers: Record<string, string> = {
    Location: signInUrl,
  };
  if (port) {
    headers["Set-Cookie"] =
      `artifacts_login_port=${port}; Path=/; Max-Age=300; SameSite=Lax`;
  }

  response.writeHead(302, headers);
  response.end();
}

function requestToUrl(request: IncomingMessage): URL {
  const host = request.headers.host ?? "localhost";
  const protocol = request.headers["x-forwarded-proto"] ?? "https";
  return new URL(request.url ?? "/", `${protocol}://${host}`);
}
