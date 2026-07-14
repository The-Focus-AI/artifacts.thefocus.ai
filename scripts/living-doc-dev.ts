#!/usr/bin/env tsx
// Local Living Doc playground: serves the real review editor, view page, and
// agent/review APIs against in-memory stores. No DATABASE_URL or Blob token
// needed — state resets on restart. Run with:
//
//   pnpm exec tsx scripts/living-doc-dev.ts
//
// Then open the printed Review URL in a browser, and drive the agent side with
// the CLI using the printed token:
//
//   THEFOCUS_ARTIFACTS_TOKEN=<token> pnpm artifacts doc pull <View URL> --base-url http://localhost:4100

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  issuePublisherToken,
  InMemoryPublisherTokenStore,
} from "../src/auth.js";
import {
  nodeRequestToWebRequest,
  writeWebResponseToNodeResponse,
} from "../src/http.js";
import {
  handleLivingDocAgentApiRequest,
  handleReviewApiRequest,
  publishLivingDoc,
  serveLivingDocViewRequest,
} from "../src/living-doc.js";
import { InMemoryLivingDocMetadataStore } from "../src/storage/living-doc-metadata.js";

const port = Number(process.env.PORT ?? 4100);
const baseUrl = `http://localhost:${port}`;

const store = new InMemoryLivingDocMetadataStore();
const tokenStore = new InMemoryPublisherTokenStore();

const { token } = await issuePublisherToken({
  email: "dev@thefocus.ai",
  store: tokenStore,
});

const sample = await publishLivingDoc({
  markdown: [
    "# Living Doc playground",
    "",
    "This document was seeded by `scripts/living-doc-dev.ts`.",
    "",
    "Try editing this text — changes autosave. Select a phrase and add a",
    "comment from the sidebar. Then pull feedback from the agent side:",
    "",
    "```bash",
    `THEFOCUS_ARTIFACTS_TOKEN=<token> pnpm artifacts doc pull ${baseUrl}/d/<opaque> --base-url ${baseUrl}`,
    "```",
  ].join("\n"),
  publisherEmail: "dev@thefocus.ai",
  publicBaseUrl: baseUrl,
  store,
  title: "Playground",
});

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
});

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", baseUrl);

  if (url.pathname.startsWith("/api/doc")) {
    const webResponse = await handleLivingDocAgentApiRequest({
      request: await nodeRequestToWebRequest(request),
      store,
      tokenStore,
      publicBaseUrl: baseUrl,
    });
    await writeWebResponseToNodeResponse(webResponse, response);
    return;
  }

  if (url.pathname.startsWith("/api/review")) {
    const webResponse = await handleReviewApiRequest({
      request: await nodeRequestToWebRequest(request),
      store,
    });
    await writeWebResponseToNodeResponse(webResponse, response);
    return;
  }

  if (url.pathname.startsWith("/d/")) {
    const webResponse = await serveLivingDocViewRequest({
      request: new Request(`${baseUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers as HeadersInit,
      }),
      store,
    });
    await writeWebResponseToNodeResponse(webResponse, response);
    return;
  }

  if (url.pathname.startsWith("/r/")) {
    const html = await readFile(
      join(process.cwd(), "public", "review.html"),
      "utf-8",
    );
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
    return;
  }

  // In production Vercel serves public/ statically; mirror the one asset the
  // review editor needs.
  if (url.pathname === "/vendor/review-editor.js") {
    const bundle = await readFile(
      join(process.cwd(), "public", "vendor", "review-editor.js"),
    );
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end(bundle);
    return;
  }

  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(
    [
      "Living Doc playground",
      "",
      `Review (editor):  ${sample.reviewUrl}`,
      `View (read-only): ${sample.viewUrl}`,
      "",
      "Agent CLI:",
      `  export THEFOCUS_ARTIFACTS_TOKEN=${token}`,
      `  pnpm artifacts doc pull ${sample.viewUrl} --base-url ${baseUrl}`,
    ].join("\n"),
  );
}

server.listen(port, () => {
  console.log(`Living Doc playground on ${baseUrl}`);
  console.log("");
  console.log(`  Review (editor):  ${sample.reviewUrl}`);
  console.log(`  View (read-only): ${sample.viewUrl}`);
  console.log("");
  console.log("Agent side (in another terminal):");
  console.log(`  export THEFOCUS_ARTIFACTS_TOKEN=${token}`);
  console.log(`  export ARTIFACTS_PUBLIC_BASE_URL=${baseUrl}`);
  console.log(`  pnpm artifacts doc pull ${sample.viewUrl}`);
  console.log(
    `  echo '{"suggestions":[{"anchorQuote":"playground","replacement":"proving ground"}]}' | pnpm artifacts doc respond ${sample.viewUrl}`,
  );
  console.log("");
  console.log("State is in-memory and resets on restart.");
});
