import type { IncomingMessage, ServerResponse } from "node:http";

import {
  issuePublisherToken,
  createNeonPublisherTokenStore,
  isTheFocusPublisherEmail,
  type PublisherTokenStore,
} from "../../src/auth.js";

import {
  createServerClerkVerifier,
  type ClerkAuthResult,
  type ClerkVerifier,
} from "../../src/auth-clerk.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const clerk = createServerClerkVerifier();
  await handleLoginCallback(request, response, {
    clerk,
    tokenStore: createNeonPublisherTokenStore(),
  });
}

export interface LoginCallbackDeps {
  clerk: ClerkVerifier;
  tokenStore: PublisherTokenStore;
  now?: () => Date;
  tokenFactory?: () => string;
}

export async function handleLoginCallback(
  request: IncomingMessage,
  response: ServerResponse,
  deps: LoginCallbackDeps,
): Promise<void> {
  const port = readLocalCallbackPort(request);
  const authResult = await authenticateWithClerk(request, response, deps.clerk);

  if (authResult.kind === "response-sent") return;

  if (authResult.kind === "unauthenticated") {
    sendLoginPage(response, {
      statusCode: 400,
      title: "Login failed",
      heading: "Login failed",
      tone: "error",
      body: authResult.message,
    });
    return;
  }

  const { email } = authResult.verification;

  if (!isTheFocusPublisherEmail(email)) {
    const message =
      "Publishing is limited to verified email addresses ending exactly in @thefocus.ai.";

    if (port) {
      redirect(
        response,
        `http://localhost:${port}/callback?error=${encodeURIComponent(message)}`,
      );
      return;
    }

    sendLoginPage(response, {
      statusCode: 403,
      title: "Login not allowed",
      heading: "Login not allowed",
      tone: "error",
      body: message,
    });
    return;
  }

  const result = await issuePublisherToken({
    email,
    store: deps.tokenStore,
    now: deps.now,
    tokenFactory: deps.tokenFactory,
  });

  if (port) {
    redirect(
      response,
      `http://localhost:${port}/callback?token=${encodeURIComponent(result.token)}`,
    );
    return;
  }

  showTokenDisplay(response, result.token, email);
}

type CallbackAuthResult =
  | {
      kind: "authenticated";
      verification: Extract<
        ClerkAuthResult,
        { kind: "authenticated" }
      >["verification"];
    }
  | { kind: "unauthenticated"; message: string }
  | { kind: "response-sent" };

async function authenticateWithClerk(
  request: IncomingMessage,
  response: ServerResponse,
  clerk: ClerkVerifier,
): Promise<CallbackAuthResult> {
  try {
    const result = await clerk.authenticateRequest(request);

    if (result.kind === "redirect") {
      forwardClerkRedirect(response, result.headers);
      return { kind: "response-sent" };
    }

    return result;
  } catch (error) {
    return {
      kind: "unauthenticated",
      message:
        "Authentication failed: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

function readLocalCallbackPort(request: IncomingMessage): number | null {
  const url = requestToUrl(request);
  const rawPort =
    url.searchParams.get("port") ?? readCookie(request, "artifacts_login_port");
  const port = parseInt(rawPort ?? "", 10);
  return port > 0 && port < 65536 ? port : null;
}

function forwardClerkRedirect(
  response: ServerResponse,
  headers: Headers,
): void {
  const location = headers.get("location");
  if (!location) {
    sendLoginPage(response, {
      statusCode: 400,
      title: "Login failed",
      heading: "Login failed",
      tone: "error",
      body: "Clerk requested an authentication handshake without a redirect location.",
    });
    return;
  }

  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "location") continue;
    response.setHeader(name, value);
  }

  response.writeHead(307, { Location: location });
  response.end();
}

function requestToUrl(request: IncomingMessage): URL {
  const host = firstHeader(request.headers.host) ?? "localhost";
  const protocol = firstHeader(request.headers["x-forwarded-proto"]) ?? "https";
  return new URL(request.url ?? "/", `${protocol}://${host}`);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { Location: location });
  response.end();
}

function showTokenDisplay(
  response: ServerResponse,
  token: string,
  email: string,
): void {
  sendLoginPage(response, {
    statusCode: 200,
    title: "Publisher Token — Artifacts",
    heading: "Publisher Token created",
    tone: "success",
    body: `Signed in as ${escapeHtml(email)}. Run this command to store your Publisher Token:<pre><code>npx @the-focus-ai/artifacts login --token ${escapeHtml(token)}</code></pre>`,
  });
}

function sendLoginPage(
  response: ServerResponse,
  options: {
    statusCode: number;
    title: string;
    heading: string;
    tone: "success" | "error";
    body: string;
  },
): void {
  const accent = options.tone === "success" ? "#16a34a" : "#dc2626";
  response.writeHead(options.statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f4; color: #1c1917; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(560px, calc(100vw - 48px)); background: #fff; border: 1px solid #e7e5e4; padding: 40px; box-shadow: 0 24px 60px rgba(28, 25, 23, 0.08); }
    .eyebrow { margin: 0 0 24px; font-size: 12px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #78716c; }
    h1 { margin: 0 0 16px; font-size: 32px; line-height: 1.1; letter-spacing: -0.04em; }
    .rule { width: 64px; height: 4px; background: ${accent}; margin: 0 0 24px; }
    p { margin: 0 0 24px; color: #57534e; font-size: 16px; line-height: 1.6; }
    a { color: #1c1917; font-weight: 700; text-underline-offset: 4px; }
    pre { margin: 20px 0 0; padding: 16px; overflow-x: auto; background: #292524; color: #fafaf9; font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">TheFocus.AI Artifacts</p>
    <h1>${escapeHtml(options.heading)}</h1>
    <div class="rule"></div>
    <p>${options.body}</p>
    <a href="/">Return to TheFocus.AI Artifacts</a>
  </main>
</body>
</html>`);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [key, ...rest] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
