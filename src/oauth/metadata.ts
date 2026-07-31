/**
 * The scope an MCP client asks for. One scope: holding a token means acting as
 * the Publisher, which is what the Publisher Token already meant.
 */
export const artifactsOAuthScope = "artifacts:publish";

/** The canonical resource identifier tokens are audience-bound to. */
export function mcpResourceIdentifier(publicBaseUrl: string): string {
  return new URL("/mcp", publicBaseUrl).toString();
}

/**
 * RFC 9728 Protected Resource Metadata. Points a client at the authorization
 * server it should log in through, and names the resource that tokens must be
 * bound to.
 */
export function protectedResourceMetadata(publicBaseUrl: string) {
  const issuer = new URL("/", publicBaseUrl).origin;
  return {
    resource: mcpResourceIdentifier(publicBaseUrl),
    authorization_servers: [issuer],
    scopes_supported: [artifactsOAuthScope],
    bearer_methods_supported: ["header"],
    resource_documentation: new URL("/llms.txt", publicBaseUrl).toString(),
  };
}

/**
 * RFC 8414 Authorization Server Metadata.
 *
 * `client_id_metadata_document_supported` is set because STD-009 R2 §3.12 tells
 * Focus clients to prefer Client ID Metadata Documents; an authorization server
 * of ours that only offered Dynamic Client Registration would put our own
 * clients in the deprecated path. `registration_endpoint` remains for clients
 * that have not moved yet.
 */
export function authorizationServerMetadata(publicBaseUrl: string) {
  const issuer = new URL("/", publicBaseUrl).origin;
  return {
    issuer,
    authorization_endpoint: new URL(
      "/oauth/authorize",
      publicBaseUrl,
    ).toString(),
    token_endpoint: new URL("/oauth/token", publicBaseUrl).toString(),
    registration_endpoint: new URL("/oauth/register", publicBaseUrl).toString(),
    scopes_supported: [artifactsOAuthScope],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    service_documentation: new URL("/llms.txt", publicBaseUrl).toString(),
  };
}
