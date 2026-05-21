import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface BrowserLoginResult {
	token: string;
}

export interface BrowserLoginError {
	error: string;
}

export interface LoginCallbackDependencies {
	openBrowser?: (url: string) => Promise<void>;
	baseUrl?: string;
}

export async function loginWithBrowserFlow(
	deps: LoginCallbackDependencies = {},
): Promise<BrowserLoginResult> {
	const baseUrl = deps.baseUrl ?? "https://artifacts.thefocus.ai";

	// Find a free port
	const port = await findFreePort();

	// Build the login URL
	const loginUrl = new URL("/login", baseUrl);
	loginUrl.searchParams.set("port", String(port));

	const result = await new Promise<BrowserLoginResult>((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost:${port}`);

			if (req.method === "GET" && url.pathname === "/callback") {
				const token = url.searchParams.get("token");
				const error = url.searchParams.get("error");

				if (token) {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(callbackSuccessHtml());
					server.close();
					resolve({ token });
					return;
				}

				if (error) {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(callbackErrorHtml(error));
					server.close();
					reject(new Error(error));
					return;
				}

				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end("Bad request");
				server.close();
				reject(new Error("No token or error received from login callback"));
				return;
			}

			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
		});

		server.on("error", (err) => {
			reject(new Error(`Login callback server failed: ${err.message}`));
		});

		server.listen(port, "127.0.0.1", () => {
			// Open the browser
			const openFn = deps.openBrowser ?? openDefaultBrowser;
			openFn(loginUrl.toString()).catch(() => {
				// If browser can't be opened, we still wait for the user to open the URL
				// The user will see the URL in the CLI output
			});
		});
	});

	return result;
}

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			server.close(() => resolve(port));
		});
	});
}

async function openDefaultBrowser(url: string): Promise<void> {
	const { exec } = await import("node:child_process");
	const command =
		process.platform === "darwin"
			? `open "${url}"`
			: process.platform === "win32"
				? `start "" "${url}"`
				: `xdg-open "${url}"`;

	return new Promise((resolve) => {
		exec(command, (error) => {
			if (error) {
				// Fall back to printing the URL on failure
				resolve();
				return;
			}
			resolve();
		});
	});
}

function callbackSuccessHtml(): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Login Successful — Artifacts</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h1 { color: #16a34a; margin: 0 0 0.5rem; }
  p { color: #666; }
</style></head>
<body>
  <div class="card">
    <h1>&check; Login Successful</h1>
    <p>Your Publisher Token has been stored. You can close this window.</p>
  </div>
</body>
</html>`;
}

function callbackErrorHtml(error: string): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Login Failed — Artifacts</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h1 { color: #dc2626; margin: 0 0 0.5rem; }
  p { color: #666; }
</style></head>
<body>
  <div class="card">
    <h1>&cross; Login Failed</h1>
    <p>${escapeHtml(error)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
