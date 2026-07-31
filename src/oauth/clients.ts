import type { OAuthClientRecord, OAuthStore } from "./store.js";

export class OAuthClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthClientError";
  }
}

/** A Client ID Metadata Document is identified by an https URL with a path. */
export function isClientIdMetadataDocumentUrl(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.pathname !== "/";
}

export interface ResolveClientInput {
  clientId: string;
  store: OAuthStore;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a client to its registered redirect URIs.
 *
 * Two paths, in the order STD-009 R2 §3.12 prefers: a Client ID Metadata
 * Document fetched from the client_id URL, or a record from Dynamic Client
 * Registration.
 */
export async function resolveOAuthClient(
  input: ResolveClientInput,
): Promise<OAuthClientRecord> {
  if (isClientIdMetadataDocumentUrl(input.clientId)) {
    return fetchClientIdMetadataDocument(
      input.clientId,
      input.fetchImpl ?? fetch,
    );
  }
  const record = await input.store.getClient(input.clientId);
  if (!record) {
    throw new OAuthClientError("invalid_client", "Unknown client_id.");
  }
  return record;
}

async function fetchClientIdMetadataDocument(
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<OAuthClientRecord> {
  let response: Response;
  try {
    response = await fetchImpl(clientId, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch (error) {
    throw new OAuthClientError(
      "invalid_client",
      `Could not fetch the Client ID Metadata Document: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new OAuthClientError(
      "invalid_client",
      `Client ID Metadata Document returned ${response.status}.`,
    );
  }

  let document: {
    client_id?: unknown;
    client_name?: unknown;
    redirect_uris?: unknown;
  };
  try {
    document = (await response.json()) as typeof document;
  } catch {
    throw new OAuthClientError(
      "invalid_client",
      "Client ID Metadata Document is not valid JSON.",
    );
  }

  // STD-009 §3.10: the URL is the identity, so a document whose client_id
  // disagrees with its own address cannot be trusted to describe that client.
  if (document.client_id !== clientId) {
    throw new OAuthClientError(
      "invalid_client",
      "Client ID Metadata Document client_id must equal the document URL.",
    );
  }

  const redirectUris = Array.isArray(document.redirect_uris)
    ? document.redirect_uris.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (redirectUris.length === 0) {
    throw new OAuthClientError(
      "invalid_client",
      "Client ID Metadata Document must list at least one redirect_uris entry.",
    );
  }

  return {
    clientId,
    clientName:
      typeof document.client_name === "string" ? document.client_name : null,
    redirectUris,
    createdAt: new Date(0),
  };
}

export interface RegisterClientInput {
  metadata: {
    client_name?: unknown;
    redirect_uris?: unknown;
  };
  store: OAuthStore;
  clientIdFactory: () => string;
  now?: () => Date;
}

/**
 * Dynamic Client Registration. Deprecated by the MCP authorization spec in
 * favour of Client ID Metadata Documents, kept as the compatibility path for
 * clients that have not moved.
 */
export async function registerOAuthClient(
  input: RegisterClientInput,
): Promise<OAuthClientRecord> {
  const redirectUris = Array.isArray(input.metadata.redirect_uris)
    ? input.metadata.redirect_uris.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (redirectUris.length === 0) {
    throw new OAuthClientError(
      "invalid_redirect_uri",
      "redirect_uris must list at least one URI.",
    );
  }
  for (const uri of redirectUris) assertUsableRedirectUri(uri);

  return input.store.createClient({
    clientId: input.clientIdFactory(),
    clientName:
      typeof input.metadata.client_name === "string"
        ? input.metadata.client_name
        : null,
    redirectUris,
    createdAt: input.now?.(),
  });
}

/**
 * Redirect URIs must be https, or loopback for a native client. Everything else
 * is either eavesdroppable or a way to bounce a code somewhere unintended.
 */
export function assertUsableRedirectUri(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new OAuthClientError(
      "invalid_redirect_uri",
      `redirect_uri is not a valid URI: ${redirectUri}`,
    );
  }
  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1" ||
      // Real MCP clients register http://localhost:PORT/callback.
      url.hostname === "localhost")
  ) {
    return;
  }
  // A custom scheme (myapp://callback) is how native clients receive codes.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  throw new OAuthClientError(
    "invalid_redirect_uri",
    `redirect_uri must be https or a loopback address: ${redirectUri}`,
  );
}

/** Exact string match, as OAuth 2.1 requires — no prefix or wildcard matching. */
export function redirectUriIsRegistered(
  client: OAuthClientRecord,
  redirectUri: string,
): boolean {
  return client.redirectUris.includes(redirectUri);
}
