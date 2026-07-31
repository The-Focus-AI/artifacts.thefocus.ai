/**
 * The consent and error pages the authorization endpoint renders. Plain HTML
 * with inline styles, matching the login pages — this repo has no framework or
 * client build pipeline for serverless-rendered pages.
 */

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function consentPageHtml(input: {
  clientName: string | null;
  clientId: string;
  publisherEmail: string;
  hiddenFields: Array<[string, string]>;
}): string {
  const name = input.clientName?.trim() || input.clientId;
  const hidden = input.hiddenFields
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join("\n      ");

  return page({
    title: "Authorize an MCP client — Artifacts",
    heading: "Authorize this client",
    accent: "#16a34a",
    body: `
    <p>
      <strong>${escapeHtml(name)}</strong> wants to publish Artifacts and Living Docs
      as <strong>${escapeHtml(input.publisherEmail)}</strong>.
    </p>
    <p class="detail">Client ID: <code>${escapeHtml(input.clientId)}</code></p>
    <p class="detail">
      Approving lets it create, update, and remove your Publications and Living Docs.
      You can revoke it later with <code>artifacts token list</code> and
      <code>artifacts token revoke</code>.
    </p>
    <form method="post">
      ${hidden}
      <button type="submit" name="approve" value="yes">Approve</button>
      <button type="submit" name="approve" value="no" class="secondary">Cancel</button>
    </form>`,
  });
}

export function oauthErrorPageHtml(message: string): string {
  return page({
    title: "Authorization failed — Artifacts",
    heading: "Authorization failed",
    accent: "#dc2626",
    body: `<p>${escapeHtml(message)}</p>`,
  });
}

function page(options: {
  title: string;
  heading: string;
  accent: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f4; color: #1c1917; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(560px, calc(100vw - 48px)); background: #fff; border: 1px solid #e7e5e4; padding: 40px; box-shadow: 0 24px 60px rgba(28, 25, 23, 0.08); }
    .eyebrow { margin: 0 0 24px; font-size: 12px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #78716c; }
    h1 { margin: 0 0 16px; font-size: 32px; line-height: 1.1; letter-spacing: -0.04em; }
    .rule { width: 64px; height: 4px; background: ${options.accent}; margin: 0 0 24px; }
    p { margin: 0 0 16px; color: #57534e; font-size: 16px; line-height: 1.6; }
    p.detail { font-size: 14px; color: #78716c; }
    code { background: #f5f5f4; padding: 2px 6px; font-size: 13px; overflow-wrap: anywhere; }
    a { color: #1c1917; font-weight: 700; text-underline-offset: 4px; }
    form { margin: 32px 0 0; display: flex; gap: 12px; flex-wrap: wrap; }
    button { font: inherit; font-weight: 700; padding: 12px 24px; border: 1px solid #1c1917; background: #1c1917; color: #fafaf9; cursor: pointer; }
    button.secondary { background: #fff; color: #1c1917; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">TheFocus.AI Artifacts</p>
    <h1>${escapeHtml(options.heading)}</h1>
    <div class="rule"></div>
    ${options.body}
  </main>
</body>
</html>`;
}
