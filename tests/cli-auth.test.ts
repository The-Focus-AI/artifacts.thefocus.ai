import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryPublisherTokenStore,
  issuePublisherToken,
} from "../src/auth.js";
import { configFilePath } from "../src/local-config.js";
import { runCli } from "../src/cli.js";

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

  it("logout removes local token state only", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "artifacts-cli-"));
    await runCli(["login", "--token", "tfai_pub_local"], { configDir });

    const exitCode = await runCli(["logout"], { configDir });

    expect(exitCode).toBe(0);
    await expect(readFile(configFilePath(configDir), "utf8")).rejects.toThrow();
  });
});
