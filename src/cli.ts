#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { realpath, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  authenticatePublisherToken,
  createNeonPublisherTokenStore,
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
import { HttpArtifactApiClient, type ArtifactApiClient } from "./remote-api.js";
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

    printUsage(stderr);
    return 1;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
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
    "Usage: npx @the-focus-ai/artifacts <login|logout|whoami|publish|remove|list>\n" +
      "  npx @the-focus-ai/artifacts login [--base-url https://artifacts.thefocus.ai]\n" +
      '  npx @the-focus-ai/artifacts publish <file.html|directory> [--entry-page index.html] [--title "My Report"] [--base-url https://artifacts.thefocus.ai] [--new] [--update <Publication URL>] [--verbose] [--open]\n' +
      "  npx @the-focus-ai/artifacts remove <Publication URL> [--yes] [--base-url https://artifacts.thefocus.ai]\n" +
      "  npx @the-focus-ai/artifacts list [--base-url https://artifacts.thefocus.ai]\n" +
      "  npx @the-focus-ai/artifacts whoami [--base-url https://artifacts.thefocus.ai]\n" +
      "  npx @the-focus-ai/artifacts logout\n",
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
