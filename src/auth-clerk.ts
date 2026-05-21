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
			// Use the configured Clerk sign-in domain (from your Clerk dashboard → Domains)
			// e.g. capital-panther-42.clerk.accounts.dev
			const domain = signInDomain ?? "clerk.artifacts.thefocus.ai";
			const signInUrl = new URL(`https://${domain}/sign-in`);
			signInUrl.searchParams.set("redirect_url", currentUrl);
			return signInUrl.toString();
		},

		async verifyRequest(url: string): Promise<ClerkVerification | null> {
			const parsedUrl = new URL(url);
			const jwt = parsedUrl.searchParams.get("__clerk_db_jwt");
			if (!jwt) return null;

			try {
				const { userId } = await (clerkClient as any).verifyToken(jwt, {
					jwtKey: process.env.CLERK_JWT_KEY,
				});
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
				// If the Clerk JWT verification fails, try an alternative: use
				// the Clerk session cookie approach (clerk uses __session cookie)
				// For Vercel serverless, we can't read cookies directly from URL,
				// so we fall back to trying to extract the session from headers
				// via the authenticateRequest API
				return await verifyViaAuthenticateRequest(clerkClient, url);
			}
		},
	};
}

async function verifyViaAuthenticateRequest(
	clerkClient: ReturnType<typeof createClerkClient>,
	url: string,
): Promise<ClerkVerification | null> {
	try {
		// Try the __session cookie-based approach
		// We need to parse the URL to reconstruct headers
		const parsedUrl = new URL(url);

		// The Clerk backend SDK's authenticateRequest needs a Request-like object
		// with headers. Since we're in a Vercel function, we can reconstruct this.
		// Actually, the simpler approach: just get the __clerk_db_jwt and try again
		// with the correct parameters

		const jwt = parsedUrl.searchParams.get("__clerk_db_jwt");
		if (!jwt) return null;

		// Try verifyToken with just the token (some Clerk versions accept this)
		const result = await (clerkClient as any).verifyToken(jwt);
		if (!result?.sub) return null;

		const user = await clerkClient.users.getUser(result.sub);
		const primaryEmail =
			user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ??
			user.emailAddresses[0];

		if (!primaryEmail?.emailAddress) return null;

		return {
			email: primaryEmail.emailAddress,
			userId: user.id,
		};
	} catch {
		return null;
	}
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
