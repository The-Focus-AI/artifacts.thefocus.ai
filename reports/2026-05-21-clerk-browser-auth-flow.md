---
title: "Clerk Browser Auth for CLI Tools: `authenticateRequest()` + `users.getUser()` Pattern"
date: 2026-05-21
topic: clerk-browser-auth-cli
recommendation: "@clerk/backend authenticateRequest() + users.getUser()"
version_researched: "@clerk/backend@3.4.11"
use_when:
  - Building a CLI tool that authenticates through Clerk's hosted sign-in page
  - Vercel/Node serverless callbacks receive raw IncomingMessage/ServerResponse objects
  - Development callbacks may include Clerk's `__clerk_db_jwt=dvb_...` handshake token
  - Production callbacks may include Clerk's `__session` cookie
avoid_when:
  - You are using Express (use @clerk/express `clerkMiddleware()` + `getAuth()`)
  - You are using Next.js (use @clerk/nextjs/server `auth()` / `getAuth()`)
project_context:
  language: TypeScript
  runtime: Node.js on Vercel serverless functions
  relevant_dependencies:
    - "@clerk/backend": "3.4.11"
---

## Summary

The simplest correct implementation for Artifacts' CLI browser login is to let Clerk authenticate the callback request with `clerkClient.authenticateRequest()`, then fetch the user's email with `clerkClient.users.getUser()` [1][2][3]. This keeps Clerk-specific session mechanics inside Clerk's SDK and keeps our code focused on application logic: verify the request, enforce the `@thefocus.ai` publisher rule, issue a Publisher Token, and redirect it back to the local CLI callback.

The important correction from the initial investigation is that `__clerk_db_jwt=dvb_...` is not a normal session JWT we should pass to `verifyToken()` directly. Clerk's backend SDK treats it as part of the development browser handshake. In production, Clerk commonly authenticates same-origin requests through the short-lived `__session` cookie; in development, Clerk may need one or more handshake redirects to synchronize browser auth state [4][5]. `authenticateRequest()` is the high-level Clerk API designed to handle these cases [1].

## Philosophy & Mental Model

Think of `/login/callback` as a very small bridge:

1. The CLI starts a localhost callback server and opens `/login?port=...`.
2. `/login` redirects the browser to Clerk's hosted sign-in page.
3. Clerk redirects back to `/login/callback` with whatever state Clerk needs for the current environment.
4. Our callback asks Clerk: "Is this request authenticated?"
5. If Clerk answers "I need a handshake redirect," our callback forwards Clerk's redirect headers.
6. If Clerk answers "signed in," our callback fetches the user's email, checks `@thefocus.ai`, issues a Publisher Token, and redirects to localhost.

The mental model is: **do not manually interpret Clerk's auth transport**. Let Clerk handle `__session`, `__clerk_db_jwt`, refresh, and handshake behavior. Our code should only handle the three outcomes Clerk gives us: authenticated, unauthenticated, or handshake redirect [1][4].

## Setup

Required environment variables:

```toml
CLERK_SECRET_KEY                  # Backend API secret key
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY # Publishable key; authenticateRequest needs instance context
CLERK_SIGN_IN_DOMAIN              # Hosted sign-in domain, e.g. possible-shrew-37.accounts.dev
```

Optional environment variable:

```toml
CLERK_AUTHORIZED_PARTIES          # comma-separated allowed origins, if stricter than request origin
```

## Core Usage Patterns

### Pattern 1: Build the hosted sign-in URL once

`/login` should construct one callback URL and pass it to Clerk as `redirect_url`:

```ts
const callbackUrl = new URL("/login/callback?port=12345", requestOrigin);
const signInUrl = buildClerkSignInUrl(callbackUrl.toString());
response.writeHead(302, { Location: signInUrl });
```

### Pattern 2: Convert Node's request to a Web `Request`

`authenticateRequest()` expects a Web `Request`. Vercel serverless functions pass Node's `IncomingMessage`, so adapt headers and URL without changing auth semantics:

```ts
function toWebRequest(request: IncomingMessage): Request {
  return new Request(requestToUrl(request), {
    method: request.method ?? "GET",
    headers: toWebHeaders(request.headers),
  });
}
```

### Pattern 3: Use `authenticateRequest()` for Clerk auth state

```ts
const requestState = await clerkClient.authenticateRequest(webRequest, {
  authorizedParties: authorizedPartiesFor(request),
});

if (requestState.status === "handshake") {
  forwardClerkRedirect(response, requestState.headers);
  return;
}

if (!requestState.isAuthenticated) {
  showError(response, requestState.message || requestState.reason);
  return;
}

const { userId } = requestState.toAuth();
```

This is the core simplification. We do not read `__session` ourselves. We do not read `__clerk_db_jwt` ourselves. We do not call `verifyToken()` for the callback path ourselves. Clerk's SDK already knows which token carrier applies and whether a development handshake is required [1][4].

### Pattern 4: Fetch email from the Backend API

The authenticated request gives us `userId`, not the email. Fetch the user from Clerk and pick the primary email [3][6]:

```ts
const user = await clerkClient.users.getUser(userId);
const primaryEmail =
  user.emailAddresses.find(
    (email) => email.id === user.primaryEmailAddressId,
  ) ?? user.emailAddresses[0];
```

### Pattern 5: Keep app-specific auth small

After Clerk authentication, our app logic is simple:

```ts
if (!isTheFocusPublisherEmail(email)) reject();
const token = await issuePublisherToken({ email, store });
redirectToLocalhostCallback(token);
```

## Anti-Patterns & Pitfalls

### Don't manually verify `__clerk_db_jwt=dvb_...`

```ts
// Avoid this for the browser callback path
const token = url.searchParams.get("__clerk_db_jwt");
await verifyToken(token, { secretKey });
```

`dvb_...` is part of Clerk's development browser synchronization flow. It is not the same thing as the production `__session` JWT cookie. `authenticateRequest()` handles this distinction for us [4][5].

### Don't build a one-off mini Clerk middleware

Manual parsing starts simple but quickly grows into handling cookies, dev-browser tokens, refresh, handshake redirects, suffixed cookies, origins, and pending sessions. Clerk's backend SDK already implements that behavior [1].

### Don't use `@clerk/express` here

`@clerk/express` is the right abstraction for Express apps. This project uses Vercel serverless functions, not Express. `@clerk/backend` is the smaller, direct SDK for this environment [7].

### Don't leak unnecessary user details in error pages

For non-`@thefocus.ai` accounts, the page should say the account is not allowed. It does not need to print the user's email. The manual token fallback may show the email because that is an explicit token issuance page.

## Why This Choice

| Criterion                    | Weight | `authenticateRequest()` + `users.getUser()`                  |
| ---------------------------- | ------ | ------------------------------------------------------------ |
| Correct in Clerk development | High   | Handles `__clerk_db_jwt` and handshake redirects [1][4]      |
| Correct in production        | High   | Handles `__session` cookies and auth state [2][5]            |
| Simple app code              | High   | App code only handles authenticated/unauthenticated/redirect |
| Framework fit                | High   | Works with raw Web `Request`, no Express/Next dependency     |
| Security                     | High   | Supports `authorizedParties` origin validation [8]           |

## References

[1] [Clerk Backend SDK - `authenticateRequest()`](https://clerk.com/docs/reference/backend/authenticate-request) — high-level request authentication API used by Clerk framework SDKs.

[2] [Clerk - Making authenticated requests](https://clerk.com/docs/guides/development/making-requests) — explains same-origin cookie auth and cross-origin bearer-token auth.

[3] [Clerk Backend API - `users.getUser()`](https://clerk.com/docs/reference/backend/user/get-user) — retrieves the Clerk user object, including email addresses.

[4] [Clerk SDK terminology - cookies and development browser token](https://clerk.com/docs/guides/development/sdk-development/terminology) — documents `__session`, `__client`, `__client_uat`, and `__clerk_db_jwt`.

[5] [Clerk - Session tokens](https://clerk.com/docs/guides/sessions/session-tokens) — explains Clerk session JWTs, short-lived cookie behavior, and default claims.

[6] [Clerk - Session token custom claims and size limits](https://clerk.com/docs/guides/sessions/session-tokens#custom-claims-and-size-limits) — recommends fetching larger user data from the Backend API rather than embedding it in tokens.

[7] [Clerk Express SDK overview](https://clerk.com/docs/reference/express/overview) — shows the Express-specific alternative (`clerkMiddleware()` + `getAuth()`), which is not the right fit for this Vercel serverless setup.

[8] [Clerk `verifyToken()` reference](https://clerk.com/docs/reference/backend/verify-token) — documents `authorizedParties` and token verification concepts used under the hood by request authentication.
