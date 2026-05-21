import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  authenticatePublisherToken,
  hashPublisherToken,
  InMemoryPublisherTokenStore,
  issuePublisherToken,
} from "../src/auth.js";
import {
  configFilePath,
  resolvePublisherToken,
  writeLocalPublisherConfig,
} from "../src/local-config.js";

const now = new Date("2026-05-21T12:00:00.000Z");

describe("Publisher Token authentication", () => {
  it("issues a raw token once for exact @thefocus.ai emails and stores only its hash", async () => {
    const store = new InMemoryPublisherTokenStore();

    const issued = await issuePublisherToken({
      email: "Publisher@TheFocus.AI",
      store,
      now: () => now,
      tokenFactory: () => "tfai_pub_test-token",
    });

    expect(issued).toMatchObject({
      token: "tfai_pub_test-token",
      publisherEmail: "publisher@thefocus.ai",
      tokenHash: hashPublisherToken("tfai_pub_test-token"),
    });
    await expect(store.getByTokenHash(issued.token)).resolves.toBeNull();
    await expect(store.getByTokenHash(issued.tokenHash)).resolves.toMatchObject(
      {
        publisherEmail: "publisher@thefocus.ai",
      },
    );
  });

  it("rejects non-TheFocus and subdomain emails without creating a token", async () => {
    const store = new InMemoryPublisherTokenStore();

    await expect(
      issuePublisherToken({ email: "person@example.com", store }),
    ).rejects.toThrow("@thefocus.ai");
    await expect(
      issuePublisherToken({ email: "person@team.thefocus.ai", store }),
    ).rejects.toThrow("@thefocus.ai");
  });

  it("validates tokens and updates last-used state", async () => {
    const store = new InMemoryPublisherTokenStore();
    const issued = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store,
      tokenFactory: () => "tfai_pub_valid",
    });

    await expect(
      authenticatePublisherToken({
        token: issued.token,
        store,
        now: () => now,
      }),
    ).resolves.toBe("publisher@thefocus.ai");
    await expect(store.getByTokenHash(issued.tokenHash)).resolves.toMatchObject(
      { lastUsedAt: now },
    );
    await expect(
      authenticatePublisherToken({ token: "wrong", store }),
    ).rejects.toThrow("valid Publisher Token");
  });
});

describe("local Publisher Token config", () => {
  it("stores local config under the config directory with restricted file permissions", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-config-"));

    await writeLocalPublisherConfig({ token: "tfai_pub_local" }, configDir);

    await expect(
      readFile(configFilePath(configDir), "utf8"),
    ).resolves.toContain("tfai_pub_local");
    expect((await stat(configFilePath(configDir))).mode & 0o777).toBe(0o600);
  });

  it("uses THEFOCUS_ARTIFACTS_TOKEN before local config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-config-"));
    await writeLocalPublisherConfig({ token: "tfai_pub_local" }, configDir);

    await expect(
      resolvePublisherToken({
        configDir,
        env: { THEFOCUS_ARTIFACTS_TOKEN: "tfai_pub_env" },
      }),
    ).resolves.toEqual({ token: "tfai_pub_env", source: "environment" });
  });
});
