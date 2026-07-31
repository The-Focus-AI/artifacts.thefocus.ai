#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  authenticatePublisherToken,
  createNeonPublisherTokenStore,
  issuePublisherToken,
  listPublisherTokens,
  revokePublisherToken,
  type PublisherTokenKind,
  type PublisherTokenStore,
} from "./auth.js";
import {
  clearLocalPublisherConfig,
  defaultConfigDir,
  FilePublicationStateStore,
  resolvePublisherToken,
  writeLocalPublisherConfig,
} from "./local-config.js";
import type { BrowserLoginResult } from "./login-flow.js";
import { loginWithBrowserFlow, openDefaultBrowser } from "./login-flow.js";
import {
  absolutePublicationUrl,
  defaultPublicBaseUrl,
  publishArtifactFromEnvironment,
  publishArtifactSummary,
  removePublicationFromEnvironment,
  removePublicationSummary,
  type RemovePublicationResult,
} from "./publication.js";
import {
  collectDocAssets,
  contentTypeForDocAssetPath,
  opaqueIdFromViewReference,
  readCollectedDocAsset,
  type RespondReplyInput,
  type RespondSuggestionInput,
} from "./living-doc.js";
import {
  HttpArtifactApiClient,
  HttpLivingDocApiClient,
  HttpPublisherTokenApiClient,
  type ArtifactApiClient,
  type LivingDocApiClient,
  type PublisherTokenApiClient,
} from "./remote-api.js";
import {
  createNeonPublicationMetadataStore,
  type PublicationMetadataStore,
} from "./storage/publication-metadata.js";

export interface CliDependencies {
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  tokenStore?: PublisherTokenStore;
  metadataStore?: PublicationMetadataStore;
  apiClient?: ArtifactApiClient;
  docApiClient?: LivingDocApiClient;
  tokenApiClient?: PublisherTokenApiClient;
  configDir?: string;
  openBrowser?: (url: string) => Promise<void>;
  stdin?: NodeJS.ReadStream;
  removePublication?: (
    publicationUrl: string,
  ) => Promise<RemovePublicationResult>;
  confirmRemoval?: (publicationUrl: string) => Promise<boolean>;
  loginFlow?: (deps: {
    baseUrl: string;
    openBrowser?: (url: string) => Promise<void>;
  }) => Promise<BrowserLoginResult>;
}

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const [command, firstArg, ...flags] = argv;
  const options = parseFlags(command === "publish" ? flags : argv.slice(1));
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const configDir = dependencies.configDir ?? defaultConfigDir(env);

  try {
    if (
      !command ||
      command === "help" ||
      command === "--help" ||
      command === "-h"
    ) {
      printUsage(stdout);
      return 0;
    }

    if (command === "publish" && firstArg) {
      const token = await resolvePublisherToken({ env, configDir });
      if (!token.token) throw new Error("A valid Publisher Token is required");

      let sourcePath = firstArg;
      if (firstArg === "-") {
        const stdinStream = dependencies.stdin ?? process.stdin;
        if (stdinStream.isTTY) {
          stdout.write(
            "Reading HTML from stdin (press Ctrl+D when finished)...\n",
          );
        }
        const content = await readStdin(stdinStream);
        await mkdir(configDir, { recursive: true });
        const tempFile = join(configDir, "stdin.html");
        await writeFile(tempFile, content, "utf-8");
        sourcePath = tempFile;
      }

      const result = dependencies.apiClient
        ? await dependencies.apiClient.publish(token.token, sourcePath, {
            publicBaseUrl: options["base-url"],
            entryPage: options["entry-page"],
            forceNew: Object.hasOwn(options, "new"),
            updatePublicationUrl: options.update,
            title: options["title"],
          })
        : dependencies.tokenStore || dependencies.metadataStore
          ? await publishArtifactFromEnvironment(sourcePath, {
              publicBaseUrl: options["base-url"],
              entryPage: options["entry-page"],
              env,
              configDir,
              forceNew: Object.hasOwn(options, "new"),
              updatePublicationUrl: options.update,
              title: options["title"],
            })
          : await publishWithDefaultApiClient(sourcePath, token.token, {
              env,
              configDir,
              publicBaseUrl: options["base-url"],
              entryPage: options["entry-page"],
              forceNew: Object.hasOwn(options, "new"),
              updatePublicationUrl: options.update,
              title: options["title"],
            });
      stdout.write(
        `${publishArtifactSummary(result, { verbose: options.verbose === "true" })}\n`,
      );
      if (Object.hasOwn(options, "open")) {
        const openFn = dependencies.openBrowser ?? openDefaultBrowser;
        await openFn(result.publicationUrl);
      }
      return 0;
    }

    if (command === "remove" && firstArg) {
      if (!Object.hasOwn(options, "yes")) {
        const confirm =
          dependencies.confirmRemoval ??
          ((publicationUrl: string) =>
            confirmRemoval(
              publicationUrl,
              dependencies.stdin ?? process.stdin,
              stdout,
            ));
        const confirmed = await confirm(firstArg);
        if (!confirmed) {
          stdout.write("Removal cancelled.\n");
          return 1;
        }
      }
      const remove =
        dependencies.removePublication ??
        (dependencies.apiClient
          ? async (publicationUrl: string) => {
              const token = await resolvePublisherToken({ env, configDir });
              if (!token.token)
                throw new Error("A valid Publisher Token is required");
              return dependencies.apiClient!.remove(
                token.token,
                publicationUrl,
              );
            }
          : dependencies.tokenStore || dependencies.metadataStore
            ? (publicationUrl: string) =>
                removePublicationFromEnvironment(publicationUrl, {
                  env,
                  configDir,
                })
            : async (publicationUrl: string) => {
                const token = await resolvePublisherToken({ env, configDir });
                if (!token.token)
                  throw new Error("A valid Publisher Token is required");
                return defaultApiClient(env, options["base-url"]).remove(
                  token.token,
                  publicationUrl,
                );
              });
      const result = await remove(firstArg);
      stdout.write(`${removePublicationSummary(result)}\n`);
      return 0;
    }

    if (command === "login") {
      if (options.token) {
        await writeLocalPublisherConfig({ token: options.token }, configDir);
        stdout.write(`Publisher Token stored in ${configDir}\n`);
        return 0;
      }
      const baseUrl = options["base-url"] ?? "https://artifacts.thefocus.ai";
      const loginUrl = new URL("/login", baseUrl);
      stdout.write("Opening browser to complete login...\n");
      stdout.write(
        `If the browser does not open, visit: ${loginUrl.toString()}\n`,
      );
      try {
        const flow = dependencies.loginFlow ?? loginWithBrowserFlow;
        const result = await flow({
          baseUrl,
          openBrowser: dependencies.openBrowser,
        });
        await writeLocalPublisherConfig({ token: result.token }, configDir);
        stdout.write(`Publisher Token stored in ${configDir}\n`);
        return 0;
      } catch (error) {
        stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
    }

    if (command === "logout") {
      await clearLocalPublisherConfig(configDir);
      stdout.write("Removed local Publisher Token state.\n");
      return 0;
    }

    if (command === "whoami") {
      const token = await resolvePublisherToken({ env, configDir });
      if (!token.token) throw new Error("Not logged in");
      const email = dependencies.tokenStore
        ? await authenticatePublisherToken({
            token: token.token,
            store: dependencies.tokenStore,
          })
        : await (
            dependencies.apiClient ?? defaultApiClient(env, options["base-url"])
          ).whoami(token.token);
      stdout.write(`${email}\n`);
      return 0;
    }

    if (command === "list") {
      const token = await resolvePublisherToken({ env, configDir });
      if (!token.token) throw new Error("A valid Publisher Token is required");
      const publications = dependencies.metadataStore
        ? await (async () => {
            const publisherEmail = await authenticatePublisherToken({
              token: token.token,
              store: dependencies.tokenStore ?? createNeonPublisherTokenStore(),
            });
            return dependencies.metadataStore!.listByPublisherEmail(
              publisherEmail,
            );
          })()
        : await (
            dependencies.apiClient ?? defaultApiClient(env, options["base-url"])
          ).list(token.token);
      stdout.write(
        `${formatPublicationList(publications, {
          publicBaseUrl:
            options["base-url"] ??
            env.ARTIFACTS_PUBLIC_BASE_URL ??
            "https://artifacts.thefocus.ai",
        })}\n`,
      );
      return 0;
    }

    if (command === "token") {
      return await runTokenCommand(firstArg, flags[0], {
        env,
        configDir,
        options,
        stdout,
        stdin: dependencies.stdin ?? process.stdin,
        tokenStore: dependencies.tokenStore,
        tokenApiClient: dependencies.tokenApiClient,
      });
    }

    if (command === "doc") {
      return await runDocCommand(firstArg, flags[0], {
        env,
        configDir,
        options,
        stdout,
        stderr,
        stdin: dependencies.stdin ?? process.stdin,
        docApiClient: dependencies.docApiClient,
      });
    }

    printUsage(stderr);
    return 1;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runDocCommand(
  subcommand: string | undefined,
  target: string | undefined,
  context: {
    env: NodeJS.ProcessEnv;
    configDir: string;
    options: Record<string, string | undefined>;
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    docApiClient?: LivingDocApiClient;
  },
): Promise<number> {
  const { env, configDir, options, stdout } = context;
  const token = await resolvePublisherToken({ env, configDir });
  if (!token.token) throw new Error("A valid Publisher Token is required");
  const client =
    context.docApiClient ??
    new HttpLivingDocApiClient(
      options["base-url"] ??
        env.ARTIFACTS_PUBLIC_BASE_URL ??
        defaultPublicBaseUrl,
    );

  if (subcommand === "publish") {
    if (!target) throw new Error("doc publish requires a Markdown file path.");
    const markdownPath = await realpath(target);
    const markdown = await readFile(markdownPath, "utf-8");
    const force = options.force === "true";
    const collected = await collectDocAssets({
      markdown,
      markdownPath,
      force,
    });
    const bytesByAssetPath = new Map<string, string>();
    const assets: Array<{
      relativeRef: string;
      assetPath: string;
      data: string;
      contentType: string;
    }> = [];
    for (const asset of collected.assets) {
      let data = bytesByAssetPath.get(asset.assetPath);
      if (!data) {
        data = (await readCollectedDocAsset(asset)).toString("base64");
        bytesByAssetPath.set(asset.assetPath, data);
      }
      assets.push({
        relativeRef: asset.relativeRef,
        assetPath: asset.assetPath,
        data,
        contentType: contentTypeForDocAssetPath(asset.assetPath),
      });
    }
    const result = await client.publishDoc(token.token, markdown, {
      title: options.title,
      assets,
    });
    if (collected.missing.length > 0) {
      context.stderr.write(
        `Warning: skipped missing Doc Assets (--force):\n${collected.missing
          .map((path) => `  - ${path}`)
          .join("\n")}\n`,
      );
    }
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (subcommand === "pull") {
    if (!target)
      throw new Error("doc pull requires a Living Doc View URL or id.");
    const result = await client.pullDoc(
      token.token,
      opaqueIdFromViewReference(target),
    );
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (subcommand === "respond") {
    if (!target)
      throw new Error("doc respond requires a Living Doc View URL or id.");
    const raw = options.body
      ? await readFile(options.body, "utf-8")
      : await readStdin(context.stdin);
    const parsed = JSON.parse(raw || "{}") as {
      suggestions?: RespondSuggestionInput[];
      replies?: RespondReplyInput[];
    };
    const result = await client.respondDoc(
      token.token,
      opaqueIdFromViewReference(target),
      { suggestions: parsed.suggestions, replies: parsed.replies },
    );
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (subcommand === "list") {
    const result = await client.listDocs(token.token);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (subcommand === "remove") {
    if (!target)
      throw new Error("doc remove requires a Living Doc View URL or id.");
    if (!Object.hasOwn(options, "yes")) {
      const confirmed = await confirmRemoval(target, context.stdin, stdout);
      if (!confirmed) {
        stdout.write("Removal cancelled.\n");
        return 1;
      }
    }
    const result = await client.removeDoc(
      token.token,
      opaqueIdFromViewReference(target),
    );
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  throw new Error(
    "Usage: artifacts doc <publish <file.md>|pull <url>|respond <url>|list|remove <url>>",
  );
}

async function runTokenCommand(
  subcommand: string | undefined,
  target: string | undefined,
  context: {
    env: NodeJS.ProcessEnv;
    configDir: string;
    options: Record<string, string | undefined>;
    stdout: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    tokenStore?: PublisherTokenStore;
    tokenApiClient?: PublisherTokenApiClient;
  },
): Promise<number> {
  const { env, configDir, options, stdout } = context;
  const active = await resolvePublisherToken({ env, configDir });
  if (!active.token) throw new Error("A valid Publisher Token is required");

  // A local store means tests or a server-side caller; otherwise go through the
  // hosted API so the CLI never needs DATABASE_URL.
  const store = context.tokenStore;
  const client =
    context.tokenApiClient ??
    new HttpPublisherTokenApiClient(
      options["base-url"] ??
        env.ARTIFACTS_PUBLIC_BASE_URL ??
        defaultPublicBaseUrl,
    );

  if (subcommand === "create") {
    const kind: PublisherTokenKind = options.for === "mcp" ? "mcp" : "cli";
    const label = options.label;
    const issued = store
      ? await issuePublisherToken({
          email: await authenticatePublisherToken({
            token: active.token,
            store,
          }),
          store,
          kind,
          label: label ?? null,
        })
      : await client.createToken(active.token, { kind, label });
    stdout.write(
      `${issued.token}\n\n` +
        `Token Id: ${issued.tokenId}  (kind: ${issued.kind}${
          issued.label ? `, label: ${issued.label}` : ""
        })\n` +
        "This is the only time the token is shown. Store it now.\n" +
        (kind === "mcp"
          ? "Use it as the Authorization: Bearer credential for the /mcp endpoint.\n"
          : ""),
    );
    return 0;
  }

  if (subcommand === "list") {
    const records: Array<{
      tokenId: string;
      kind: string;
      label: string | null;
      createdAt: Date | string;
      lastUsedAt: Date | string | null;
      revokedAt: Date | string | null;
    }> = store
      ? await listPublisherTokens({
          publisherEmail: await authenticatePublisherToken({
            token: active.token,
            store,
          }),
          store,
        })
      : await client.listTokens(active.token);
    stdout.write(`${formatTokenList(records)}\n`);
    return 0;
  }

  if (subcommand === "revoke") {
    if (!target) throw new Error("token revoke requires a Token Id.");
    if (!Object.hasOwn(options, "yes")) {
      const confirmed = await confirmRevocation(target, context.stdin, stdout);
      if (!confirmed) {
        stdout.write("Revocation cancelled.\n");
        return 1;
      }
    }
    const result = store
      ? await revokePublisherToken({
          tokenId: target,
          publisherEmail: await authenticatePublisherToken({
            token: active.token,
            store,
          }),
          store,
        })
      : await client.revokeToken(active.token, target);
    stdout.write(`${result.tokenId}: ${result.status}\n`);
    return result.status === "not-found" ? 1 : 0;
  }

  throw new Error(
    "Usage: artifacts token <create [--for mcp] [--label name]|list|revoke <Token Id> [--yes]>",
  );
}

function formatTokenList(
  records: Array<{
    tokenId: string;
    kind: string;
    label: string | null;
    createdAt: Date | string;
    lastUsedAt: Date | string | null;
    revokedAt: Date | string | null;
  }>,
): string {
  const lines = [
    "TOKEN ID      KIND  STATUS    CREATED                   LAST USED                 LABEL",
  ];
  if (records.length === 0) {
    lines.push("No Publisher Tokens found.");
    return lines.join("\n");
  }
  for (const record of records) {
    const status = record.revokedAt ? "revoked" : "active";
    const lastUsed = record.lastUsedAt
      ? new Date(record.lastUsedAt).toISOString()
      : "never";
    lines.push(
      `${record.tokenId.padEnd(13)} ${record.kind.padEnd(5)} ${status.padEnd(
        9,
      )} ${new Date(record.createdAt).toISOString()}  ${lastUsed.padEnd(25)} ${
        record.label ?? ""
      }`.trimEnd(),
    );
  }
  return lines.join("\n");
}

async function confirmRevocation(
  tokenId: string,
  stdin: NodeJS.ReadStream,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<boolean> {
  if (!stdin.isTTY) {
    throw new Error("Revocation requires --yes in non-interactive terminals.");
  }
  const readline = createInterface({
    input: stdin,
    output: stdout as NodeJS.WriteStream,
  });
  try {
    const answer = await readline.question(
      `Revoke Publisher Token ${tokenId}? Anything using it stops working. Type yes to continue: `,
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}

async function publishWithDefaultApiClient(
  sourcePath: string,
  token: string,
  options: {
    env: NodeJS.ProcessEnv;
    configDir: string;
    publicBaseUrl?: string;
    entryPage?: string;
    forceNew?: boolean;
    updatePublicationUrl?: string;
    title?: string;
  },
) {
  const stateStore = new FilePublicationStateStore(options.configDir);
  const localSourcePath = await realpath(sourcePath);
  const existingState = await stateStore.get(localSourcePath);
  const now = new Date();
  const shouldUpdateExisting =
    !options.forceNew &&
    existingState !== null &&
    existingState.revisionWindowExpiresAt.getTime() >= now.getTime();
  const updatePublicationUrl =
    options.updatePublicationUrl ??
    (shouldUpdateExisting ? existingState.publicationUrl : undefined);
  const result = await defaultApiClient(
    options.env,
    options.publicBaseUrl,
  ).publish(token, sourcePath, {
    publicBaseUrl: options.publicBaseUrl,
    entryPage: options.entryPage,
    forceNew: options.forceNew,
    updatePublicationUrl,
    title: options.title,
  });
  try {
    await stateStore.set({
      localSourcePath,
      opaqueId: result.opaqueId,
      publicationUrl: result.publicationUrl,
      revisionWindowExpiresAt: result.revisionWindowExpiresAt,
    });
  } catch {
    // State write is non-critical — publish already succeeded
  }
  return result;
}

function defaultApiClient(
  env: NodeJS.ProcessEnv,
  explicitBaseUrl?: string,
): HttpArtifactApiClient {
  return new HttpArtifactApiClient(
    explicitBaseUrl ?? env.ARTIFACTS_PUBLIC_BASE_URL ?? defaultPublicBaseUrl,
  );
}

function parseFlags(flags: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (!flag?.startsWith("--")) continue;
    const [name, inlineValue] = flag.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      parsed[name] = inlineValue;
      continue;
    }
    const next = flags[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[name] = "true";
      continue;
    }
    parsed[name] = next;
    index += 1;
  }
  return parsed;
}

function formatPublicationList(
  publications: Awaited<
    ReturnType<PublicationMetadataStore["listByPublisherEmail"]>
  >,
  options: { publicBaseUrl: string },
): string {
  const lines = [
    "LAST UPDATED              STATUS    TITLE                            PUBLICATION URL",
  ];
  if (publications.length === 0) {
    lines.push("No Publications found.");
    return lines.join("\n");
  }
  for (const publication of publications) {
    const title = (publication.title ?? "").slice(0, 30).padEnd(32);
    lines.push(
      `${publication.updatedAt.toISOString()}  ${publication.status.padEnd(
        8,
      )} ${title}${absolutePublicationUrl(
        options.publicBaseUrl,
        publication.publicationUrlPath,
      )}`,
    );
  }
  return lines.join("\n");
}

async function confirmRemoval(
  publicationUrl: string,
  stdin: NodeJS.ReadStream,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<boolean> {
  if (!stdin.isTTY) {
    throw new Error("Removal requires --yes in non-interactive terminals.");
  }
  const readline = createInterface({
    input: stdin,
    output: stdout as NodeJS.WriteStream,
  });
  try {
    const answer = await readline.question(
      `Remove ${publicationUrl}? Removal cannot be undone. Type yes to continue: `,
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
    stdout.write("");
  }
}

function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

function printUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    "Usage: npx @the-focus-ai/artifacts <login|logout|whoami|publish|remove|list|doc|token>\n" +
      "  npx @the-focus-ai/artifacts login [--base-url https://artifacts.thefocus.ai]\n" +
      '  npx @the-focus-ai/artifacts publish <file.html|directory> [--entry-page index.html] [--title "My Report"] [--base-url https://artifacts.thefocus.ai] [--new] [--update <Publication URL>] [--verbose] [--open]\n' +
      "  npx @the-focus-ai/artifacts remove <Publication URL> [--yes] [--base-url https://artifacts.thefocus.ai]\n" +
      "  npx @the-focus-ai/artifacts list [--base-url https://artifacts.thefocus.ai]\n" +
      "  npx @the-focus-ai/artifacts whoami [--base-url https://artifacts.thefocus.ai]\n" +
      "  npx @the-focus-ai/artifacts logout\n" +
      '  npx @the-focus-ai/artifacts doc publish <file.md> [--title "My Doc"] [--force] [--base-url ...]\n' +
      "  npx @the-focus-ai/artifacts doc pull <Living Doc View URL or id> [--base-url ...]\n" +
      "  npx @the-focus-ai/artifacts doc respond <Living Doc View URL or id> [--body feedback.json] [--base-url ...]\n" +
      "  npx @the-focus-ai/artifacts doc list [--base-url ...]\n" +
      "  npx @the-focus-ai/artifacts doc remove <Living Doc View URL or id> [--yes] [--base-url ...]\n" +
      '  npx @the-focus-ai/artifacts token create [--for mcp] [--label "claude desktop"] [--base-url ...]\n' +
      "  npx @the-focus-ai/artifacts token list [--base-url ...]\n" +
      "  npx @the-focus-ai/artifacts token revoke <Token Id> [--yes] [--base-url ...]\n",
  );
}

const isDirectRun = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false;

if (isDirectRun) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
