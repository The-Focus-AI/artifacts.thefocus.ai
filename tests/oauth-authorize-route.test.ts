import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { handleAuthorizeRequest } from "../api/oauth/authorize.js";
import type { ClerkAuthResult, ClerkVerifier } from "../src/auth-clerk.js";
import { handleRegister, InMemoryOAuthStore } from "../src/index.js";

const publicBaseUrl = "https://artifacts.thefocus.ai";
const redirectUri = "http://localhost:47821/callback";

function clerkStub(result: ClerkAuthResult): ClerkVerifier {
  return { authenticateRequest: async () => result };
}

const signedIn = clerkStub({
  kind: "authenticated",
  verification: { email: "publisher@thefocus.ai", userId: "user_1" },
});

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/**
 * Run the route on a real HTTP server: the CSRF check reads request headers, so
 * a hand-built IncomingMessage would not exercise it honestly.
 */
async function serve(deps: {
  clerk: ClerkVerifier;
  store: InMemoryOAuthStore;
}): Promise<string> {
  server = createServer((request, response) => {
    void handleAuthorizeRequest(request, response, {
      clerk: deps.clerk,
      store: deps.store,
      publicBaseUrl,
    }).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function registeredClient(store: InMemoryOAuthStore): Promise<string> {
  const outcome = await handleRegister({
    metadata: { client_name: "Test", redirect_uris: [redirectUri] },
    store,
  });
  return (outcome.body as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string): URLSearchParams {
  const verifier = randomBytes(32).toString("base64url");
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "state-1",
    resource: `${publicBaseUrl}/mcp`,
  });
}

describe("authorize route", () => {
  it("renders the consent page to a signed-in Publisher", async () => {
    const store = new InMemoryOAuthStore();
    const base = await serve({ clerk: signedIn, store });
    const clientId = await registeredClient(store);

    const response = await fetch(
      `${base}/oauth/authorize?${authorizeQuery(clientId)}`,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Authorize this client");
    expect(html).toContain("publisher@thefocus.ai");
    expect(html).toContain('name="approve" value="yes"');
  });

  it("sends an unauthenticated visitor to Clerk sign-in", async () => {
    const store = new InMemoryOAuthStore();
    const base = await serve({
      clerk: clerkStub({ kind: "unauthenticated", message: "no session" }),
      store,
    });
    const clientId = await registeredClient(store);

    const response = await fetch(
      `${base}/oauth/authorize?${authorizeQuery(clientId)}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/sign-in");
  });

  it("issues a code on a same-origin approval", async () => {
    const store = new InMemoryOAuthStore();
    const base = await serve({ clerk: signedIn, store });
    const clientId = await registeredClient(store);

    const response = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
      },
      body: new URLSearchParams([
        ...authorizeQuery(clientId).entries(),
        ["approve", "yes"],
      ]),
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("state-1");
  });

  it("refuses an approval posted from another origin", async () => {
    const store = new InMemoryOAuthStore();
    const base = await serve({ clerk: signedIn, store });
    const clientId = await registeredClient(store);

    const response = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: new URLSearchParams([
        ...authorizeQuery(clientId).entries(),
        ["approve", "yes"],
      ]),
      redirect: "manual",
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("did not come from");
  });

  it("forwards Clerk's Set-Cookie so the consent POST still has a session", async () => {
    const store = new InMemoryOAuthStore();
    const headers = new Headers();
    headers.append("set-cookie", "__session=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "__client_uat=1; Path=/");
    const base = await serve({
      clerk: {
        authenticateRequest: async () => ({
          kind: "authenticated" as const,
          verification: { email: "publisher@thefocus.ai", userId: "user_1" },
          headers,
        }),
      },
      store,
    });
    const clientId = await registeredClient(store);

    const response = await fetch(
      `${base}/oauth/authorize?${authorizeQuery(clientId)}`,
    );

    // Repeated cookies must stay separate; folding them into one comma-joined
    // header is what silently drops the session.
    expect(response.headers.getSetCookie()).toEqual([
      "__session=abc; Path=/; HttpOnly",
      "__client_uat=1; Path=/",
    ]);
  });

  it("stops instead of looping when sign-in returns without a session", async () => {
    const store = new InMemoryOAuthStore();
    const base = await serve({
      clerk: clerkStub({ kind: "unauthenticated", message: "no session" }),
      store,
    });
    const clientId = await registeredClient(store);
    const query = authorizeQuery(clientId);

    // First visit: one redirect to sign-in, carrying the attempt marker.
    const first = await fetch(`${base}/oauth/authorize?${query}`, {
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    const signInUrl = new URL(first.headers.get("location")!);
    const resume = new URL(signInUrl.searchParams.get("redirect_url")!);
    expect(resume.searchParams.get("__artifacts_signin")).toBe("1");
    expect(resume.searchParams.get("client_id")).toBe(clientId);

    // Clerk bounces the browser back still unauthenticated: explain, do not
    // redirect again.
    const second = await fetch(`${base}${resume.pathname}${resume.search}`, {
      redirect: "manual",
    });
    expect(second.status).toBe(401);
    expect(second.headers.get("location")).toBeNull();
    expect(await second.text()).toContain("did not receive a session");
  });

  it("resumes an unauthenticated consent POST with its parameters intact", async () => {
    const store = new InMemoryOAuthStore();
    const base = await serve({
      clerk: clerkStub({ kind: "unauthenticated", message: "no session" }),
      store,
    });
    const clientId = await registeredClient(store);

    const response = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
      },
      body: new URLSearchParams([
        ...authorizeQuery(clientId).entries(),
        ["approve", "yes"],
      ]),
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    const resume = new URL(
      new URL(response.headers.get("location")!).searchParams.get(
        "redirect_url",
      )!,
    );
    expect(resume.searchParams.get("client_id")).toBe(clientId);
    expect(resume.searchParams.get("code_challenge")).toBeTruthy();
    expect(resume.searchParams.get("approve")).toBeNull();
  });

  it("treats Cancel as a refusal without issuing a code", async () => {
    const store = new InMemoryOAuthStore();
    const base = await serve({ clerk: signedIn, store });
    const clientId = await registeredClient(store);

    const response = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
      },
      body: new URLSearchParams([
        ...authorizeQuery(clientId).entries(),
        ["approve", "no"],
      ]),
      redirect: "manual",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("cancelled");
  });
});
