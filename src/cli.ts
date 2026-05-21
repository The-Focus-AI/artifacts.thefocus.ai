#!/usr/bin/env node

import {
  publishArtifactFromEnvironment,
  singleFilePublishSummary,
} from "./publication.js";

async function main(argv: string[]): Promise<void> {
  const [command, sourcePath, ...flags] = argv;
  if (command !== "publish" || !sourcePath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const options = parseFlags(flags);
  const result = await publishArtifactFromEnvironment(sourcePath, {
    publicBaseUrl: options["base-url"],
    publisherEmail: options["publisher-email"],
    entryPage: options["entry-page"],
  });
  console.log(singleFilePublishSummary(result));
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

function printUsage(): void {
  console.error(
    "Usage: artifacts publish <file.html|directory> [--entry-page index.html] [--base-url https://artifacts.thefocus.ai] [--publisher-email you@thefocus.ai]",
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
