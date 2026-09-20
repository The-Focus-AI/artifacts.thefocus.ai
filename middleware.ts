import { rewrite } from "@vercel/functions";

import { pwaMiddlewareRewriteUrl } from "./src/pwa-host.js";

export default function middleware(request: Request): Response | undefined {
  const destination = pwaMiddlewareRewriteUrl(request);
  if (!destination) return undefined;
  return rewrite(destination);
}
