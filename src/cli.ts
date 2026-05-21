#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  authenticatePublisherToken,
  createNeonPublisherTokenStore,
  type PublisherTokenStore,
} from "./auth.js";
import {
  clearLocalPublisherConfig,
  defaultConfigDir,
  resolvePublisherToken,
  writeLocalPublisherConfig,
} from "./local-config.js";
import type { BrowserLoginResult } from "./login-flow.js";
import { loginWithBrowserFlow } from "./login-flow.js";
import {
  absolutePublicationUrl,
  publishArtifactFromEnvironment,
  publishArtifactSummary,
} from "./publication.js";
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
  configDir?: string;
  openBrowser?: (url: string) => Promise<void>;
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
    if (command === "publish" && firstArg) {
      const result = await publishArtifactFromEnvironment(firstArg, {
        publicBaseUrl: options["base-url"],
        entryPage: options["entry-page"],
        env,
        configDir,
        forceNew: Object.hasOwn(options, "new"),
        updatePublicationUrl: options.update,
      });
      stdout.write(
        `${publishArtifactSummary(result, { verbose: options.verbose === "true" })}\n`,
      );
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
      const email = await authenticatePublisherToken({
        token: token.token,
        store: dependencies.tokenStore ?? createNeonPublisherTokenStore(),
      });
      stdout.write(`${email}\n`);
      return 0;
    }

    if (command === "list") {
      const token = await resolvePublisherToken({ env, configDir });
      if (!token.token) throw new Error("A valid Publisher Token is required");
      const publisherEmail = await authenticatePublisherToken({
        token: token.token,
        store: dependencies.tokenStore ?? createNeonPublisherTokenStore(),
      });
      const publications = await (
        dependencies.metadataStore ?? createNeonPublicationMetadataStore()
      ).listByPublisherEmail(publisherEmail);
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
  const lines = ["LAST UPDATED              STATUS    PUBLICATION URL"];
  if (publications.length === 0) {
    lines.push("No Publications found.");
    return lines.join("\n");
  }
  for (const publication of publications) {
    lines.push(
      `${publication.updatedAt.toISOString()}  ${publication.status.padEnd(
        8,
      )} ${absolutePublicationUrl(
        options.publicBaseUrl,
        publication.publicationUrlPath,
      )}`,
    );
  }
  return lines.join("\n");
}

function printUsage(stderr: Pick<NodeJS.WriteStream, "write">): void {
  stderr.write(
    "Usage: artifacts <login|logout|whoami|publish|list>\n" +
      "  artifacts login [--base-url https://artifacts.thefocus.ai]\n" +
      "  artifacts publish <file.html|directory> [--entry-page index.html] [--base-url https://artifacts.thefocus.ai] [--new] [--update <Publication URL>] [--verbose]\n" +
      "  artifacts list [--base-url https://artifacts.thefocus.ai]\n" +
      "  artifacts whoami\n" +
      "  artifacts logout\n",
  );
}

const isDirectRun = process.argv[1]
  ? fileURLToPath(import.meta.url) === process.argv[1]
  : false;

if (isDirectRun) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
