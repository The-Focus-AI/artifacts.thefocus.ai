import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

import type { PublisherTokenStore } from "../auth.js";
import type { PublicationStateStore } from "../local-config.js";
import type { DocAssetContentStore } from "../storage/doc-asset-content.js";
import type { LivingDocMetadataStore } from "../storage/living-doc-metadata.js";
import type { ArtifactContentStore } from "../storage/artifact-content.js";
import type { PublicationMetadataStore } from "../storage/publication-metadata.js";

/**
 * Everything a tool needs to do its work, assembled once per request by the
 * route. Tools never construct stores themselves, so tests can drive the whole
 * catalog against in-memory ones.
 */
export interface McpToolContext {
  /**
   * The authenticated Publisher. The credential itself is not carried past the
   * route: it may be a Publisher Token or an OAuth access token, and tools
   * should not care which.
   */
  publisherEmail: string;
  publicBaseUrl: string;
  tokenStore: PublisherTokenStore;
  publicationMetadataStore: PublicationMetadataStore;
  artifactContentStore: ArtifactContentStore;
  publicationStateStore: PublicationStateStore;
  livingDocStore: LivingDocMetadataStore;
  docAssetContentStore: DocAssetContentStore;
}

/**
 * Per STD-010 §3.1, a tool either changes something or answers "what can I ask
 * about" — never both. `discovery` tools are read-only and safe to call
 * speculatively; `mutation` tools create, update, or remove.
 *
 * STD-010's other half of §3.1 — the "visual tool" carrying a citation and a
 * UI resource — does not apply here. These tools return Publication URLs and
 * Living Doc state, not quantitative claims about a dataset, so there is
 * nothing to cite. See docs/adr/0007.
 */
export type McpToolKind = "mutation" | "discovery";

export interface McpToolSpec<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  kind: McpToolKind;
  inputSchema: Shape;
  destructive?: boolean;
  run(args: Record<string, unknown>, context: McpToolContext): Promise<unknown>;
}

/**
 * Register a spec on an MCP server. One projection, so a tool added to the
 * catalog appears on the wire without touching this file (STD-010 §3.2).
 */
export function registerToolOnMcpServer(
  server: McpServer,
  spec: McpToolSpec,
  context: McpToolContext,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        title: spec.title,
        readOnlyHint: spec.kind === "discovery",
        destructiveHint: spec.destructive ?? false,
        idempotentHint: spec.kind === "discovery",
        openWorldHint: true,
      },
    },
    (async (args: Record<string, unknown>) => {
      try {
        const result = await spec.run(args ?? {}, context);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
      // The SDK's ToolCallback generic is keyed to the literal shape passed at
      // the call site; the catalog is heterogeneous, so it is erased here.
    }) as never,
  );
}
