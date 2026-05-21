import { createClerkClient } from "@clerk/backend";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

export interface ClerkVerification {
  email: string;
  userId: string;
}

export type ClerkAuthResult =
  | { kind: "authenticated"; verification: ClerkVerification }
  | { kind: "redirect"; headers: Headers }
  | { kind: "unauthenticated"; message: string };

export interface ClerkVerifier {
  authenticateRequest(request: IncomingMessage): Promise<ClerkAuthResult>;
}

export function buildClerkSignInUrl(
  returnUrl: string,
  signInDomain = process.env["CLERK_SIGN_IN_DOMAIN"] ??
    "possible-shrew-37.accounts.dev",
): string {
  const signInUrl = new URL(`https://${signInDomain}/sign-in`);
  signInUrl.searchParams.set("redirect_url", returnUrl);
  return signInUrl.toString();
}

export function createServerClerkVerifier(
  secretKey = requiredEnv("CLERK_SECRET_KEY"),
  publishableKey = requiredEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
): ClerkVerifier {
  const clerkClient = createClerkClient({ secretKey, publishableKey });

  return {
    async authenticateRequest(
      request: IncomingMessage,
    ): Promise<ClerkAuthResult> {
      const webRequest = toWebRequest(request);
      const requestState = await clerkClient.authenticateRequest(webRequest, {
        authorizedParties: authorizedPartiesFor(request),
      });

      if (requestState.status === "handshake") {
        return { kind: "redirect", headers: requestState.headers };
      }

      if (!requestState.isAuthenticated) {
        return {
          kind: "unauthenticated",
          message:
            requestState.message ||
            requestState.reason ||
            "Could not verify your Clerk session.",
        };
      }

      const auth = requestState.toAuth();
      if (!auth.userId) {
        return {
          kind: "unauthenticated",
          message: "Clerk authenticated the request but did not return a user.",
        };
      }

      const email = await primaryEmailForUser(clerkClient, auth.userId);
      if (!email) {
        return {
          kind: "unauthenticated",
          message:
            "Clerk authenticated the request but no email was available.",
        };
      }

      return {
        kind: "authenticated",
        verification: { email, userId: auth.userId },
      };
    },
  };
}

async function primaryEmailForUser(
  clerkClient: ReturnType<typeof createClerkClient>,
  userId: string,
): Promise<string | null> {
  const user = await clerkClient.users.getUser(userId);
  const primaryEmail =
    user.emailAddresses.find(
      (email) => email.id === user.primaryEmailAddressId,
    ) ?? user.emailAddresses[0];

  return primaryEmail?.emailAddress ?? null;
}

function toWebRequest(request: IncomingMessage): Request {
  return new Request(requestToUrl(request), {
    method: request.method ?? "GET",
    headers: toWebHeaders(request.headers),
  });
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(name, item);
      continue;
    }
    webHeaders.set(name, value);
  }
  return webHeaders;
}

function authorizedPartiesFor(request: IncomingMessage): string[] {
  const configured = process.env["CLERK_AUTHORIZED_PARTIES"];
  if (configured) {
    return configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  return [requestToUrl(request).origin];
}

function requestToUrl(request: IncomingMessage): URL {
  const host = firstHeader(request.headers.host) ?? "localhost";
  const protocol = firstHeader(request.headers["x-forwarded-proto"]) ?? "https";
  return new URL(request.url ?? "/", `${protocol}://${host}`);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
