import { describe, expect, it } from "vitest";

import { loginWithBrowserFlow } from "../src/login-flow.js";

describe("loginWithBrowserFlow", () => {
  it("receives a token via localhost callback and returns it", async () => {
    const result = await loginWithBrowserFlow({
      baseUrl: "https://artifacts.thefocus.ai",
      openBrowser: async (url: string) => {
        // Extract the port from the login URL
        const parsedUrl = new URL(url);
        const port = parsedUrl.searchParams.get("port");
        if (!port) throw new Error("Missing port in login URL");

        // Simulate the server redirecting back to localhost with a token
        const callbackUrl = `http://localhost:${port}/callback?token=tfai_pub_callbacksim`;

        // Make the HTTP request to the CLI's localhost callback server
        const http = await import("node:http");
        await new Promise<void>((resolve, reject) => {
          const req = http.get(callbackUrl, (res) => {
            res.resume();
            res.on("end", resolve);
          });
          req.on("error", reject);
        });
      },
    });

    expect(result.token).toBe("tfai_pub_callbacksim");
  });

  it("rejects when the server returns an error via localhost callback", async () => {
    const promise = loginWithBrowserFlow({
      baseUrl: "https://artifacts.thefocus.ai",
      openBrowser: async (url: string) => {
        const parsedUrl = new URL(url);
        const port = parsedUrl.searchParams.get("port");
        if (!port) throw new Error("Missing port in login URL");

        const callbackUrl = `http://localhost:${port}/callback?error=${encodeURIComponent(
          "Publishing is limited to verified email addresses ending exactly in @thefocus.ai.",
        )}`;

        const http = await import("node:http");
        await new Promise<void>((resolve, reject) => {
          const req = http.get(callbackUrl, (res) => {
            res.resume();
            res.on("end", resolve);
          });
          req.on("error", reject);
        });
      },
    });

    await expect(promise).rejects.toThrow("@thefocus.ai");
  });
});
