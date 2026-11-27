import {
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Password gate for Publications. See
 * docs/adr/0010-publication-passwords.md for the decisions behind it.
 *
 * The stored form is `scrypt$N$r$p$salt$hash`, so the cost parameters can
 * change later without a migration.
 */
const scryptCost = { N: 16_384, r: 8, p: 1 };
const scryptKeyLength = 32;
const minPasswordLength = 4;
const maxPasswordLength = 200;

/** Password attempts allowed per Publication and client address per window. */
export const unlockAttemptLimit = 10;
export const unlockAttemptWindowMs = 60_000;

/** Browsers cap cookie lifetime at 400 days. Used when an unlock has no limit. */
const maxCookieAgeSeconds = 400 * 24 * 60 * 60;

export async function hashPassword(password: string): Promise<string> {
  if (
    typeof password !== "string" ||
    password.length < minPasswordLength ||
    password.length > maxPasswordLength
  ) {
    throw new Error(
      `Password must be ${minPasswordLength} to ${maxPasswordLength} characters.`,
    );
  }
  const salt = randomBytes(16);
  const hash = await derive(password, salt, scryptCost);
  return [
    "scrypt",
    scryptCost.N,
    scryptCost.r,
    scryptCost.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, N, r, p, salt, hash] = stored.split("$");
  if (algorithm !== "scrypt" || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function derive(
  password: string,
  salt: Buffer,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, scryptKeyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/**
 * Parses an unlock limit. `12h`, `7d`, `30m` → milliseconds. `never` → null
 * (no limit). undefined → undefined (leave the stored value unchanged).
 */
export function parseUnlockFor(
  input: string | null | undefined,
): number | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const value = input.trim().toLowerCase();
  if (value === "" || value === "never" || value === "forever") return null;
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match || Number(match[1]) < 1) {
    throw new Error(
      "--unlock-for takes a duration such as 30m, 12h or 7d, or never.",
    );
  }
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "m" | "h" | "d"
  ];
  const ms = Number(match[1]) * unit;
  // A browser keeps the unlock cookie for at most 400 days.
  if (ms > maxCookieAgeSeconds * 1000) {
    throw new Error("--unlock-for can be at most 400d.");
  }
  return ms;
}

// --- Unlock cookie ---------------------------------------------------------
//
// The only cookie a Publication sets. It is scoped to one Publication path,
// carries no identity, and is signed with the stored password hash as the
// key. The hash never leaves the server, and changing or clearing the
// password changes the key, so every earlier unlock stops working.

function cookieName(opaqueId: string): string {
  return `unlock_${opaqueId}`;
}

function sign(opaqueId: string, passwordHash: string, issuedAt: string) {
  return createHmac("sha256", passwordHash)
    .update(`unlock:${opaqueId}:${issuedAt}`)
    .digest("base64url");
}

export function unlockCookie(input: {
  opaqueId: string;
  passwordHash: string;
  unlockTtlMs: number | null;
  path: string;
  secure: boolean;
  now?: Date;
}): string {
  const issuedAt = String((input.now ?? new Date()).getTime());
  const maxAge =
    input.unlockTtlMs === null
      ? maxCookieAgeSeconds
      : Math.max(1, Math.round(input.unlockTtlMs / 1000));
  return [
    `${cookieName(input.opaqueId)}=${issuedAt}.${sign(input.opaqueId, input.passwordHash, issuedAt)}`,
    `Path=${input.path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(input.secure ? ["Secure"] : []),
  ].join("; ");
}

export function isUnlocked(input: {
  cookieHeader: string | null;
  opaqueId: string;
  passwordHash: string;
  unlockTtlMs: number | null;
  now?: Date;
}): boolean {
  const raw = parseCookies(input.cookieHeader)[cookieName(input.opaqueId)];
  if (!raw) return false;
  const [issuedAt, signature] = raw.split(".");
  if (!issuedAt || !signature) return false;
  const expected = Buffer.from(
    sign(input.opaqueId, input.passwordHash, issuedAt),
  );
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }
  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) return false;
  const now = (input.now ?? new Date()).getTime();
  return input.unlockTtlMs === null || now - issued < input.unlockTtlMs;
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

// --- Page ------------------------------------------------------------------
//
// The page carries nothing from the Publication: no Title, no Open Graph
// tags, no Artifact content. Publications are served from more than one
// domain, so the page has no brand of its own: the label is the host that
// served the request, the colors follow the reader's light or dark setting,
// and the fonts are the system's (no request to a font host).

export function passwordPage(error: string | null, host: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Password required</title>
    <style>
      :root {
        color-scheme: light dark;
        --page: #fbfbfa;
        --text: #17181a;
        --muted: #5d6066;
        --field: #ffffff;
        --border: #cfd1d4;
        --button: #17181a;
        --button-text: #ffffff;
        --error: #b3261e;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --page: #111214;
          --text: #ececec;
          --muted: #9c9fa5;
          --field: #1a1b1e;
          --border: #3a3c41;
          --button: #ececec;
          --button-text: #111214;
          --error: #f2877f;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--page);
        color: var(--text);
        font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { width: 100%; max-width: 380px; }
      .host {
        margin: 0 0 18px;
        font: 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--muted);
        overflow-wrap: anywhere;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 26px;
        line-height: 1.2;
        font-weight: 650;
        letter-spacing: -0.015em;
      }
      p { margin: 0 0 22px; color: var(--muted); }
      p.error { margin: -8px 0 18px; color: var(--error); }
      form { display: flex; gap: 8px; }
      input {
        flex: 1;
        min-width: 0;
        padding: 11px 12px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--field);
        color: inherit;
        font: inherit;
      }
      input:focus-visible, button:focus-visible {
        outline: 2px solid var(--text);
        outline-offset: 2px;
      }
      button {
        padding: 11px 20px;
        border: 0;
        border-radius: 6px;
        background: var(--button);
        color: var(--button-text);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="host">${escapeHtml(host)}</p>
      <h1>This page needs a password</h1>
      <p>Enter the password you were given with the link.</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form method="post">
        <input type="password" name="password" aria-label="Password" autocomplete="current-password" autofocus required />
        <button type="submit">Open</button>
      </form>
    </main>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
