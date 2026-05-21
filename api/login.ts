import type { IncomingMessage, ServerResponse } from "node:http";

export default async function handler(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = requestToUrl(request);
	const port = url.searchParams.get("port") ?? "";

	const clerkDomain =
		process.env["CLERK_SIGN_IN_DOMAIN"] ?? "possible-shrew-37.accounts.dev";
	// Clerk JS SDK is served from the .clerk subdomain
	const clerkCdn = clerkDomain.replace(".accounts.dev", ".clerk.accounts.dev");
	const publishableKey = process.env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] ?? "";

	// Build the callback URL — where Clerk redirects after sign-in
	const callbackOrigin = `${url.protocol}//${url.host}`;
	const callbackPath = port
		? `/login/callback?port=${port}`
		: `/login/callback`;

	const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Artifacts</title>
  <style>
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
      font-family: system-ui, sans-serif;
    }
    #clerk-sign-in {
      width: 100%;
      max-width: 440px;
    }
  </style>
  <script
    async
    crossorigin="anonymous"
    src="https://${clerkCdn}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"
    data-clerk-publishable-key="${publishableKey}"
    data-clerk-sign-in-url="/login"
    data-clerk-after-sign-in-url="${callbackOrigin}${callbackPath}"
  ></script>
  <link
    rel="preload"
    href="https://${clerkCdn}/npm/@clerk/ui@1/dist/ui.browser.js"
    as="script"
    crossorigin="anonymous"
  />
  <script
    async
    crossorigin="anonymous"
    src="https://${clerkCdn}/npm/@clerk/ui@1/dist/ui.browser.js"
  ></script>
</head>
<body>
  <div id="clerk-sign-in"></div>

  <script>
    async function loadClerk() {
      const clerk = window.Clerk;
      if (!clerk) {
        setTimeout(loadClerk, 100);
        return;
      }

      await clerk.load();

      // If already signed in, redirect to callback
      if (clerk.user) {
        window.location.href = "${callbackOrigin}${callbackPath}";
        return;
      }

      // Mount the sign-in component
      clerk.mountSignIn(document.getElementById("clerk-sign-in"), {
        afterSignInUrl: "${callbackOrigin}${callbackPath}",
        afterSignUpUrl: "${callbackOrigin}${callbackPath}",
      });
    }

    loadClerk();
  </script>
</body>
</html>`;

	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	response.end(html);
}

function requestToUrl(request: IncomingMessage): URL {
	const host = request.headers.host ?? "localhost";
	const protocol = request.headers["x-forwarded-proto"] ?? "https";
	return new URL(request.url ?? "/", `${protocol}://${host}`);
}
