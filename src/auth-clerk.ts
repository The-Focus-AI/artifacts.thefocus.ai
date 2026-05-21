import { createClerkClient } from "@clerk/backend";

export interface ClerkVerification {
  email: string;
  userId: string;
}

export interface ClerkVerifier {
  buildSignInUrl(currentUrl: string): string;
  verifyRequest(
    url: string,
    headers: Record<string, string>,
  ): Promise<ClerkVerification | null>;
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
      url: string,
      headers: Record<string, string>,
    ): Promise<ClerkVerification | null> {
      try {
        // Use Clerk's authenticateRequest which handles dev browser tokens
        const clerkHeaders = new Headers();
        for (const [key, value] of Object.entries(headers)) {
          clerkHeaders.set(key, value);
        }

        const request = new Request(url, { headers: clerkHeaders });
        const requestState =
          await clerkClient.authenticateRequest(request);

        if (!requestState.isSignedIn) return null;

        const userId = requestState.toAuth()?.userId;
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
      } catch {
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
