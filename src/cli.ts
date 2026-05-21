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
import {
  publishSingleFileArtifactFromEnvironment,
  singleFilePublishSummary,
} from "./publication.js";

export interface CliDependencies {
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  tokenStore?: PublisherTokenStore;
  configDir?: string;
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
      const result = await publishSingleFileArtifactFromEnvironment(firstArg, {
        publicBaseUrl: options["base-url"],
      });
      stdout.write(`${singleFilePublishSummary(result)}\n`);
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
      loginUrl.searchParams.set("cli", "1");
      stdout.write(
        `Open this login URL in a browser to get a Publisher Token:\n${loginUrl.toString()}\n`,
      );
      return 0;
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
    parsed[name] = inlineValue ?? flags[index + 1];
    if (!inlineValue) index += 1;
  }
  return parsed;
}

function printUsage(stderr: Pick<NodeJS.WriteStream, "write">): void {
  stderr.write(
    "Usage: artifacts <login|logout|whoami|publish>\n" +
      "  artifacts login [--base-url https://artifacts.thefocus.ai]\n" +
      "  artifacts publish <file.html> [--base-url https://artifacts.thefocus.ai]\n" +
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
