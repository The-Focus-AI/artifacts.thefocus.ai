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

/** Wrong passwords allowed per Publication and client address per window. */
export const unlockFailureLimit = 10;
export const unlockFailureWindowMs = 60_000;

/** Browsers cap cookie lifetime at 400 days. Used when an unlock has no limit. */
const maxCookieAgeSeconds = 400 * 24 * 60 * 60;

export async function hashPassword(password: string): Promise<string> {
  if (
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
  return Number(match[1]) * unit;
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
// tags, no Artifact content.

export function passwordPage(error: string | null): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Password required</title>
    <style>
      :root {
        --paper: #faf9f6;
        --ink: #161616;
        --petrol: #0e3b46;
        --vermilion: #c3471d;
        --border: #d4d3cf;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--paper);
        color: var(--ink);
        font: 16px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
      }
      main { width: 100%; max-width: 380px; }
      .eyebrow {
        margin: 0 0 20px;
        font: 12px/1 "Courier Prime", ui-monospace, monospace;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--petrol);
      }
      h1 {
        margin: 0 0 10px;
        font: 600 30px/1.15 "Source Serif 4", Georgia, serif;
        letter-spacing: -0.01em;
      }
      p { margin: 0 0 22px; color: rgb(22 22 22 / 0.7); }
      p.error { margin: -8px 0 18px; color: var(--vermilion); }
      form { display: flex; gap: 8px; }
      input {
        flex: 1;
        min-width: 0;
        padding: 11px 12px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: #fff;
        color: inherit;
        font: inherit;
      }
      input:focus-visible, button:focus-visible {
        outline: 2px solid var(--petrol);
        outline-offset: 2px;
      }
      button {
        padding: 11px 20px;
        border: 0;
        border-radius: 4px;
        background: var(--petrol);
        color: var(--paper);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">TheFocus.AI Artifacts</p>
      <h1>This page needs a password</h1>
      <p>Enter the password you were given with the link.</p>
      ${error ? `<p class="error" role="alert">${error}</p>` : ""}
      <form method="post">
        <input type="password" name="password" aria-label="Password" autocomplete="current-password" autofocus required />
        <button type="submit">Open</button>
      </form>
    </main>
  </body>
</html>
`;
}
