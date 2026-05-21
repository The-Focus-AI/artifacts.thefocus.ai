import { mkdir, mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  publishArtifactSummary,
  publishDirectoryArtifact,
  publishSingleFileArtifact,
} from "../src/index.js";

function stores() {
  return {
    metadataStore: new InMemoryPublicationMetadataStore(),
    contentStore: new InMemoryArtifactContentStore(),
  };
}

describe("Artifact packaging safety exclusions", () => {
  it("excludes dangerous defaults while preserving .well-known and not applying .gitignore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-safety-"));
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, ".hidden"));
    await mkdir(join(dir, ".well-known"));
    await mkdir(join(dir, "cache"));
    await writeFile(join(dir, "index.html"), "<h1>Safe</h1>");
    await writeFile(join(dir, "app.js"), "console.log('included');");
    await writeFile(
      join(dir, "ignored.txt"),
      "included because .gitignore is not applied",
    );
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(join(dir, "node_modules", "pkg.js"), "excluded");
    await writeFile(join(dir, ".git", "config"), "excluded");
    await writeFile(join(dir, ".hidden", "file.txt"), "excluded");
    await writeFile(join(dir, "cache", "bundle.tmp"), "excluded");
    await writeFile(join(dir, ".env"), "SECRET=excluded");
    await writeFile(join(dir, "secret.pem"), "excluded");
    await writeFile(join(dir, ".well-known", "security.txt"), "included");

    const published = await publishDirectoryArtifact({
      directoryPath: dir,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      opaqueId: "Safety1",
      manifestRef: "manifest-safety",
      ...stores(),
    });

    expect(published.artifactPaths.sort()).toEqual([
      ".well-known/security.txt",
      "app.js",
      "ignored.txt",
      "index.html",
    ]);
    expect(published.excludedArtifactPaths.sort()).toEqual([
      ".env",
      ".git/",
      ".gitignore",
      ".hidden/",
      "cache/",
      "node_modules/",
      "secret.pem",
    ]);
  });

  it("rejects symlinks by default with a clear error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-symlink-"));
    await writeFile(join(dir, "index.html"), "<h1>Home</h1>");
    await writeFile(join(dir, "target.txt"), "target");
    await symlink(join(dir, "target.txt"), join(dir, "linked.txt"));

    await expect(
      publishDirectoryArtifact({
        directoryPath: dir,
        publisherEmail: "publisher@thefocus.ai",
        publicBaseUrl: "https://artifacts.thefocus.ai",
        ...stores(),
      }),
    ).rejects.toThrow(/Symlinks are not supported.*linked\.txt/);
  });
});

describe("Artifact upload preflight guardrails", () => {
  it("fails before upload when a single file exceeds 25 MB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-large-file-"));
    const htmlPath = join(dir, "large.html");
    await writeFile(htmlPath, "");
    await truncate(htmlPath, 25 * 1024 * 1024 + 1);
    const deps = stores();

    await expect(
      publishSingleFileArtifact({
        filePath: htmlPath,
        publisherEmail: "publisher@thefocus.ai",
        publicBaseUrl: "https://artifacts.thefocus.ai",
        ...deps,
      }),
    ).rejects.toThrow(/exceeds the 25 MB single-file limit/);
    expect((deps.contentStore as any).entries.size).toBe(0);
  });

  it("fails before upload when total Artifact size exceeds 100 MB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-total-size-"));
    await writeFile(join(dir, "index.html"), "<h1>Home</h1>");
    for (let index = 0; index < 5; index += 1) {
      const filePath = join(dir, `large-${index}.bin`);
      await writeFile(filePath, "");
      await truncate(filePath, 21 * 1024 * 1024);
    }
    const deps = stores();

    await expect(
      publishDirectoryArtifact({
        directoryPath: dir,
        publisherEmail: "publisher@thefocus.ai",
        publicBaseUrl: "https://artifacts.thefocus.ai",
        ...deps,
      }),
    ).rejects.toThrow(/exceeds the 100 MB total Artifact limit/);
    expect((deps.contentStore as any).entries.size).toBe(0);
  });

  it("fails before upload when file count exceeds 1,000", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-file-count-"));
    await writeFile(join(dir, "index.html"), "<h1>Home</h1>");
    for (let index = 0; index < 1000; index += 1) {
      await writeFile(join(dir, `file-${index}.txt`), "x");
    }
    const deps = stores();

    await expect(
      publishDirectoryArtifact({
        directoryPath: dir,
        publisherEmail: "publisher@thefocus.ai",
        publicBaseUrl: "https://artifacts.thefocus.ai",
        ...deps,
      }),
    ).rejects.toThrow(/exceeds the 1,000 file limit/);
    expect((deps.contentStore as any).entries.size).toBe(0);
  });
});

describe("publish output warnings", () => {
  it("summarizes excluded files concisely and shows detail only for verbose output", () => {
    const result = {
      publicationUrlPath: "/a/Safety1",
      publicationUrl: "https://artifacts.thefocus.ai/a/Safety1",
      excludedArtifactPaths: [".env", "node_modules/"],
    };

    expect(publishArtifactSummary(result)).toContain(
      "Warning: 2 files or directories were excluded by packaging safety rules. Re-run with --verbose to see details.",
    );
    expect(publishArtifactSummary(result)).not.toContain("node_modules/");
    expect(publishArtifactSummary(result, { verbose: true })).toContain(
      "Excluded paths:\n- .env\n- node_modules/",
    );
  });
});
