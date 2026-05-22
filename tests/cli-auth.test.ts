import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryPublisherTokenStore,
  issuePublisherToken,
} from "../src/auth.js";
import { configFilePath } from "../src/local-config.js";
import { runCli } from "../src/cli.js";
import { InMemoryPublicationMetadataStore } from "../src/storage/publication-metadata.js";

function streamCapture() {
  let text = "";
  return {
    stream: {
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

describe("CLI Publisher Token commands", () => {
  it("prints help successfully for npx smoke verification", async () => {
    const stdout = streamCapture();
    const stderr = streamCapture();

    const exitCode = await runCli(["--help"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("Usage: artifacts");
    expect(stderr.text()).toBe("");
  });

  it("completes browser login flow and stores the token automatically", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
    const stdout = streamCapture();
    const stderr = streamCapture();

    const exitCode = await runCli(
      ["login", "--base-url", "https://preview.test"],
      {
        configDir,
        stdout: stdout.stream,
        stderr: stderr.stream,
        loginFlow: async () => ({ token: "tfai_pub_browser_flow" }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("Opening browser to complete login...");
    expect(stdout.text()).toContain("https://preview.test/login");
    expect(stdout.text()).toContain("Publisher Token stored");
    expect(stderr.text()).toBe("");
    await expect(
      readFile(configFilePath(configDir), "utf8"),
    ).resolves.toContain("tfai_pub_browser_flow");
  });

  it("reports login errors from the browser flow on stderr", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
    const stdout = streamCapture();
    const stderr = streamCapture();

    const exitCode = await runCli(
      ["login", "--base-url", "https://preview.test"],
      {
        configDir,
        stdout: stdout.stream,
        stderr: stderr.stream,
        loginFlow: async () => {
          throw new Error("non-@thefocus.ai email rejected");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("non-@thefocus.ai email rejected");
  });

  it("stores a Publisher Token locally for callback-driven login", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
    const stdout = streamCapture();

    const exitCode = await runCli(["login", "--token", "tfai_pub_callback"], {
      configDir,
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    await expect(
      readFile(configFilePath(configDir), "utf8"),
    ).resolves.toContain("tfai_pub_callback");
  });

  it("reports whoami for the active token and lets the environment override local config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
    const tokenStore = new InMemoryPublisherTokenStore();
    await issuePublisherToken({
      email: "local@thefocus.ai",
      store: tokenStore,
      tokenFactory: () => "tfai_pub_local",
    });
    await issuePublisherToken({
      email: "env@thefocus.ai",
      store: tokenStore,
      tokenFactory: () => "tfai_pub_env",
    });
    await runCli(["login", "--token", "tfai_pub_local"], { configDir });
    const stdout = streamCapture();

    const exitCode = await runCli(["whoami"], {
      configDir,
      tokenStore,
      env: { THEFOCUS_ARTIFACTS_TOKEN: "tfai_pub_env" },
      stdout: stdout.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("env@thefocus.ai\n");
  });

  it("lists the active Publisher's active and removed Publications", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
    const tokenStore = new InMemoryPublisherTokenStore();
    const metadataStore = new InMemoryPublicationMetadataStore({
      now: () => new Date("2026-05-20T12:00:00.000Z"),
    });
    await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store: tokenStore,
      tokenFactory: () => "tfai_pub_list",
    });
    await runCli(["login", "--token", "tfai_pub_list"], { configDir });
    await metadataStore.create({
      opaqueId: "ActivePub",
      publisherEmail: "publisher@thefocus.ai",
      activeManifestRef: "manifest-active",
      activeArtifactLocator: "blob://active",
    });
    await metadataStore.create({
      opaqueId: "OtherPub",
      publisherEmail: "other@thefocus.ai",
      activeManifestRef: "manifest-other",
      activeArtifactLocator: "blob://other",
    });
    await metadataStore.create({
      opaqueId: "RemovedPub",
      publisherEmail: "publisher@thefocus.ai",
      activeManifestRef: "manifest-removed",
      activeArtifactLocator: "blob://removed",
    });
    await metadataStore.markRemoved("RemovedPub");
    const stdout = streamCapture();
    const stderr = streamCapture();

    const exitCode = await runCli(
      ["list", "--base-url", "https://preview.test"],
      {
        configDir,
        tokenStore,
        metadataStore,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("LAST UPDATED");
    expect(stdout.text()).toContain("STATUS");
    expect(stdout.text()).toContain("PUBLICATION URL");
    expect(stdout.text()).toContain(
      "2026-05-20T12:00:00.000Z  active   https://preview.test/a/ActivePub",
    );
    expect(stdout.text()).toContain(
      "2026-05-20T12:00:00.000Z  removed  https://preview.test/a/RemovedPub",
    );
    expect(stdout.text()).not.toContain("OtherPub");
  });

  it("requires an authenticated Publisher Token before listing Publications", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
    const stderr = streamCapture();

    const exitCode = await runCli(["list"], {
      configDir,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("A valid Publisher Token is required");
  });

  it("logout removes local token state only", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
    await runCli(["login", "--token", "tfai_pub_local"], { configDir });

    const exitCode = await runCli(["logout"], { configDir });

    expect(exitCode).toBe(0);
    await expect(readFile(configFilePath(configDir), "utf8")).rejects.toThrow();
  });

  it("removes a Publication with --yes without prompting", async () => {
    const stdout = streamCapture();
    const removePublication = vi.fn(async (publicationUrl: string) => ({
      opaqueId: "RemoveMe",
      publicationUrl,
      status: "removed" as const,
      deletedLocators: ["blob://one"],
      clearedLocalSourcePath: "/tmp/artifact",
    }));
    const confirmRemoval = vi.fn(async () => false);

    const exitCode = await runCli(
      ["remove", "https://artifacts.thefocus.ai/a/RemoveMe", "--yes"],
      {
        stdout: stdout.stream,
        removePublication,
        confirmRemoval,
      },
    );

    expect(exitCode).toBe(0);
    expect(confirmRemoval).not.toHaveBeenCalled();
    expect(removePublication).toHaveBeenCalledWith(
      "https://artifacts.thefocus.ai/a/RemoveMe",
    );
    expect(stdout.text()).toContain(
      "Removed https://artifacts.thefocus.ai/a/RemoveMe",
    );
  });

  it("asks for confirmation before interactive Removal", async () => {
    const stdout = streamCapture();
    const removePublication = vi.fn(async (publicationUrl: string) => ({
      opaqueId: "RemoveMe",
      publicationUrl,
      status: "removed" as const,
      deletedLocators: [],
      clearedLocalSourcePath: null,
    }));
    const confirmRemoval = vi.fn(async () => true);

    const exitCode = await runCli(
      ["remove", "https://artifacts.thefocus.ai/a/RemoveMe"],
      {
        stdout: stdout.stream,
        removePublication,
        confirmRemoval,
      },
    );

    expect(exitCode).toBe(0);
    expect(confirmRemoval).toHaveBeenCalledWith(
      "https://artifacts.thefocus.ai/a/RemoveMe",
    );
    expect(removePublication).toHaveBeenCalledOnce();
  });

  it("cancels Removal when confirmation is declined", async () => {
    const stdout = streamCapture();
    const removePublication = vi.fn();

    const exitCode = await runCli(
      ["remove", "https://artifacts.thefocus.ai/a/RemoveMe"],
      {
        stdout: stdout.stream,
        removePublication,
        confirmRemoval: async () => false,
      },
    );

    expect(exitCode).toBe(1);
    expect(removePublication).not.toHaveBeenCalled();
    expect(stdout.text()).toContain("Removal cancelled.");
  });
});
