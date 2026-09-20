export const defaultPwaParentHost = "artifacts.thefocus.ai";

const reservedPwaLabels = new Set([
  "www",
  "api",
  "mcp",
  "login",
  "oauth",
  "mail",
]);

export const pwaManifestArtifactPaths = [
  "manifest.webmanifest",
  "manifest.json",
] as const;

export const pwaServiceWorkerArtifactPaths = [
  "sw.js",
  "service-worker.js",
] as const;

export function isDnsSafeOpaqueId(opaqueId: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(opaqueId);
}

export function isPwaOpaqueLabel(opaqueId: string): boolean {
  return (
    opaqueId.length > 0 &&
    !opaqueId.includes(".") &&
    !reservedPwaLabels.has(opaqueId.toLowerCase()) &&
    isDnsSafeOpaqueId(opaqueId)
  );
}

export function pwaParentHostFromPublicBaseUrl(publicBaseUrl: string): string {
  return new URL(publicBaseUrl).host;
}

export function isPwaWildcardHost(
  hostname: string,
  parentHost = defaultPwaParentHost,
): boolean {
  const host = stripPort(hostname);
  const suffix = `.${parentHost}`;
  if (!host.endsWith(suffix)) return false;
  return isPwaOpaqueLabel(host.slice(0, -suffix.length));
}

export function pwaRouteFromHost(
  hostname: string,
  pathname: string,
  parentHost = defaultPwaParentHost,
): { opaqueId: string; artifactPath: string } | null {
  const host = stripPort(hostname);
  if (!isPwaWildcardHost(host, parentHost)) return null;
  const opaqueId = host.slice(0, -(parentHost.length + 1));
  return {
    opaqueId,
    artifactPath: decodeURIComponent(pathname.replace(/^\/+/, "")),
  };
}

export function pwaRouteFromUrl(
  url: string,
  parentHost = defaultPwaParentHost,
): { opaqueId: string; artifactPath: string } | null {
  const parsed = new URL(url);
  return pwaRouteFromHost(parsed.hostname, parsed.pathname, parentHost);
}

export function pwaPublicationUrl(
  publicBaseUrl: string,
  opaqueId: string,
): string {
  const base = new URL(publicBaseUrl);
  return `${base.protocol}//${opaqueId}.${base.host}/`;
}

export function publicationShareUrl(
  publicBaseUrl: string,
  input: {
    opaqueId: string;
    publicationUrlPath: string;
    pwa?: boolean;
  },
): string {
  if (input.pwa) return pwaPublicationUrl(publicBaseUrl, input.opaqueId);
  const base = publicBaseUrl.endsWith("/")
    ? publicBaseUrl
    : `${publicBaseUrl}/`;
  return new URL(input.publicationUrlPath.replace(/^\/+/, ""), base).toString();
}

export function isPwaServiceWorkerArtifactPath(artifactPath: string): boolean {
  const name = artifactPath.split("/").pop() ?? artifactPath;
  return (pwaServiceWorkerArtifactPaths as readonly string[]).includes(name);
}

export function isPwaManifestArtifactPath(artifactPath: string): boolean {
  const name = artifactPath.split("/").pop() ?? artifactPath;
  return (pwaManifestArtifactPaths as readonly string[]).includes(name);
}

export function assertPwaBundle(
  files: Array<{ artifactPath: string; body?: string | Uint8Array }>,
): void {
  const paths = new Set(files.map((file) => file.artifactPath));
  const manifestPath = pwaManifestArtifactPaths.find((path) => paths.has(path));
  const serviceWorkerPath = pwaServiceWorkerArtifactPaths.find((path) =>
    paths.has(path),
  );
  if (!manifestPath) {
    throw new Error(
      "PWA publish requires a web app manifest at /manifest.webmanifest or /manifest.json.",
    );
  }
  if (!serviceWorkerPath) {
    throw new Error(
      "PWA publish requires a service worker at /sw.js or /service-worker.js.",
    );
  }
  const manifestFile = files.find((file) => file.artifactPath === manifestPath);
  const hasIconFile = [...paths].some((path) => isPwaIconArtifactPath(path));
  if (!hasIconFile && !manifestHasIcons(manifestFile?.body)) {
    throw new Error(
      "PWA publish requires at least one icon (manifest icons[] or an icon image in the bundle).",
    );
  }
}

export function pwaMiddlewareRewriteUrl(request: Request): URL | null {
  const url = new URL(request.url);
  if (!isPwaWildcardHost(url.hostname)) return null;
  if (url.pathname === "/api/pwa" || url.pathname.startsWith("/api/pwa/")) {
    return null;
  }
  const destination = new URL("/api/pwa", url.origin);
  destination.search = url.search;
  const artifactPath = url.pathname.replace(/^\/+/, "");
  if (artifactPath) destination.searchParams.set("path", artifactPath);
  return destination;
}

function isPwaIconArtifactPath(artifactPath: string): boolean {
  return (
    /\.(png|ico|svg|webp|jpg|jpeg)$/i.test(artifactPath) &&
    /icon/i.test(artifactPath)
  );
}

function manifestHasIcons(body: string | Uint8Array | undefined): boolean {
  if (body === undefined) return false;
  try {
    const parsed = JSON.parse(
      typeof body === "string" ? body : new TextDecoder().decode(body),
    ) as { icons?: unknown };
    return Array.isArray(parsed.icons) && parsed.icons.length > 0;
  } catch {
    return false;
  }
}

function stripPort(hostname: string): string {
  return hostname.split(":")[0] ?? hostname;
}
