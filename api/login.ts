import type { IncomingMessage, ServerResponse } from "node:http";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = requestToUrl(request);
  const portParam = url.searchParams.get("port");
  const port = portParam ?? "";

  // Build the Clerk sign-in URL with the callback URL pointing at /login/callback
  const clerkDomain =
    process.env["CLERK_SIGN_IN_DOMAIN"] ?? "clerk.artifacts.thefocus.ai";
  const callbackUrl = new URL(
    `/login/callback${port ? `?port=${port}` : ""}`,
    `${url.protocol}//${url.host}`,
  );

  const signInUrl = new URL(`https://${clerkDomain}/sign-in`);
  signInUrl.searchParams.set("redirect_url", callbackUrl.toString());

  response.writeHead(302, { Location: signInUrl.toString() });
  response.end();
}

function requestToUrl(request: IncomingMessage): URL {
  const host = request.headers.host ?? "localhost";
  const protocol = request.headers["x-forwarded-proto"] ?? "https";
  return new URL(request.url ?? "/", `${protocol}://${host}`);
}
