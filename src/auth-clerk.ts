import { createClerkClient } from "@clerk/backend";

export interface ClerkVerification {
  email: string;
  userId: string;
}

export interface ClerkVerifier {
  buildSignInUrl(currentUrl: string): string;
  verifyRequest(url: string): Promise<ClerkVerification | null>;
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

    async verifyRequest(url: string): Promise<ClerkVerification | null> {
      const parsedUrl = new URL(url);

      // Get session token: __clerk_db_jwt for dev, __session for JWT templates
      const jwt =
        parsedUrl.searchParams.get("__clerk_db_jwt") ??
        parsedUrl.searchParams.get("__session");

      if (!jwt) return null;

      try {
        // For dev browser tokens, use Clerk's verifyToken which
        // handles the dvb_ prefix tokens
        const { userId } = await (clerkClient as any).verifyToken(jwt);
        if (!userId) return null;

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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
