import { createClerkClient, verifyToken } from "@clerk/backend";
import type { IncomingMessage } from "node:http";

export interface ClerkVerification {
  email: string;
  userId: string;
}

export interface ClerkVerifier {
  buildSignInUrl(currentUrl: string): string;
  /**
   * Verify a Clerk session form the incoming request after a hosted sign-in
   * page redirect. Reads the `__session` cookie set by Clerk on the
   * application domain (production pattern), falling back to the
   * `__clerk_db_jwt` query parameter (development-only pattern).
   */
  verifyRequest(request: IncomingMessage): Promise<ClerkVerification | null>;
}

export function createServerClerkVerifier(
  secretKey = requiredEnv("CLERK_SECRET_KEY"),
  signInDomain = process.env["CLERK_SIGN_IN_DOMAIN"],
): ClerkVerifier {
  const clerkClient = createClerkClient({ secretKey });

  return {
    buildSignInUrl(currentUrl: string) {
      const domain = signInDomain ?? "clerk.artifacts.thefocus.ai";
      const signInUrl = new URL(`https://${domain}/sign-in`);
      signInUrl.searchParams.set("redirect_url", currentUrl);
      return signInUrl.toString();
    },

    async verifyRequest(
      request: IncomingMessage,
    ): Promise<ClerkVerification | null> {
      // Production: Clerk sets a short-lived `__session` cookie on
      // the application domain after the hosted sign-in page
      // redirect. This is the primary token source.
      const cookieToken = readCookie(request, "__session");

      // Development fallback: Clerk's `.accounts.dev` domains
      // append `__clerk_db_jwt` as a query parameter. Never
      // present in production.
      const url = requestToUrl(request);
      const queryToken = url.searchParams.get("__clerk_db_jwt");

      const sessionToken = cookieToken ?? queryToken;

      if (!sessionToken) return null;

      try {
        // Verify the JWT signature and extract the user ID (sub).
        // `verifyToken()` is a standalone export — NOT a method
        // on clerkClient. See:
        // https://clerk.com/docs/reference/backend/verify-token
        const result = await verifyToken(sessionToken, {
          secretKey,
          authorizedParties: ["https://artifacts.thefocus.ai"],
        });

        if (result.errors || !result.data) {
          console.error(
            "clerk: verifyToken failed:",
            JSON.stringify(result.errors),
          );
          return null;
        }

        const userId = (result.data as Record<string, unknown>).sub as
          | string
          | undefined;
        if (!userId) return null;

        // The session token does NOT include the user's email —
        // fetch the full User object from the Backend API.
        const user = await clerkClient.users.getUser(userId);
        const primaryEmail =
          user.emailAddresses.find(
            (e) => e.id === user.primaryEmailAddressId,
          ) ?? user.emailAddresses[0];

        if (!primaryEmail?.emailAddress) return null;

        return {
          email: primaryEmail.emailAddress,
          userId: user.id,
        };
      } catch (err) {
        // Token verification or user lookup failed
        return null;
      }
    },
  };
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

function requestToUrl(request: IncomingMessage): URL {
  const host = request.headers.host ?? "localhost";
  const protocol = request.headers["x-forwarded-proto"] ?? "https";
  return new URL(request.url ?? "/", `${protocol}://${host}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
