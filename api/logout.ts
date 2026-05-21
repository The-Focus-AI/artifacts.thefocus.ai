import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  const clerkDomain =
    process.env["CLERK_SIGN_IN_DOMAIN"] ?? "possible-shrew-37.accounts.dev";
  const clerkCdn = clerkDomain.replace(".accounts.dev", ".clerk.accounts.dev");
  const publishableKey = process.env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] ?? "";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sign out — Artifacts</title>
  <script crossorigin="anonymous"
    src="https://${clerkCdn}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"
    data-clerk-publishable-key="${publishableKey}">
  </script>
</head>
<body>
  <p>Signing out...</p>
  <script>
    (async () => {
      const clerk = window.Clerk;
      if (clerk) {
        await clerk.load();
        await clerk.signOut();
      }
      // After sign-out, go to login
      window.location.href = "/login";
    })();
  </script>
</body>
</html>`;

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}
