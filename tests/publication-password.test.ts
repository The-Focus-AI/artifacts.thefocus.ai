import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { servePublicationNodeRequest } from "../src/http.js";
import {
  artifactsMcpTools,
  InMemoryArtifactContentStore,
  InMemoryPublicationMetadataStore,
  InMemoryPublicationStateStore,
  PostgresPublicationMetadataStore,
  publishArtifact,
  servePublicationRequest,
  setPublicationPassword,
  type McpToolContext,
} from "../src/index.js";
import { isUnlocked, unlockCookie } from "../src/password-gate.js";

const secretBody = "<title>Q3 board numbers</title><h1>secret revenue</h1>";

async function publishProtected(
  options: {
    password?: string;
    unlockFor?: string;
    directory?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "artifacts-password-"));
  let sourcePath = join(dir, "report.html");
  if (options.directory) {
    sourcePath = join(dir, "site");
    await mkdir(join(sourcePath, "assets"), { recursive: true });
    await writeFile(join(sourcePath, "index.html"), secretBody);
    await writeFile(join(sourcePath, "assets", "data.json"), '{"secret":1}');
  } else {
    await writeFile(sourcePath, secretBody);
  }
  const stores = {
    metadataStore: new InMemoryPublicationMetadataStore(),
    contentStore: new InMemoryArtifactContentStore(),
    stateStore: new InMemoryPublicationStateStore(),
  };
  const publishInput = {
    sourcePath,
    publisherEmail: "publisher@thefocus.ai",
    publicBaseUrl: "https://artifacts.thefocus.ai",
    ...stores,
    opaqueIdFactory: () => "Locked01",
  };
  const published = await publishArtifact({
    ...publishInput,
    password: "password" in options ? options.password : "open-sesame",
    unlockFor: options.unlockFor,
  });
  return { ...stores, published, publishInput, sourcePath };
}

type Stores = Pick<
  Awaited<ReturnType<typeof publishProtected>>,
  "metadataStore" | "contentStore"
>;

function get(stores: Stores, url: string, cookie?: string) {
  return servePublicationRequest({
    request: new Request(url, { headers: cookie ? { cookie } : {} }),
    metadataStore: stores.metadataStore,
    contentStore: stores.contentStore,
  });
}

function post(
  stores: Stores,
  url: string,
  password: string,
  headers: Record<string, string> = {},
) {
  return servePublicationRequest({
    request: new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({ password }).toString(),
    }),
    metadataStore: stores.metadataStore,
    contentStore: stores.contentStore,
  });
}

function cookieFrom(response: Response): string {
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

const url = "https://artifacts.thefocus.ai/a/Locked01";

describe("Publication passwords", () => {
  it("serves the password page instead of the Artifact, with nothing from the Publication on it", async () => {
    const stores = await publishProtected();

    const response = await get(stores, url);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain('type="password"');
    expect(body).not.toContain("secret revenue");
    expect(body).not.toContain("Q3 board numbers");
    expect(body).not.toContain("og:");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("gates every Artifact Path of a directory Artifact, not only the Entry Page", async () => {
    const stores = await publishProtected({ directory: true });

    const locked = await get(stores, `${url}/assets/data.json`);
    expect(locked.status).toBe(401);
    expect(await locked.text()).not.toContain("secret");

    const unlock = await post(stores, url, "open-sesame");
    const opened = await get(
      stores,
      `${url}/assets/data.json`,
      cookieFrom(unlock),
    );
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('{"secret":1}');
  });

  it("rejects a wrong password and unlocks with the right one", async () => {
    const stores = await publishProtected();

    const wrong = await post(stores, url, "open-sesame-2");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.text()).toContain("That password is not right.");

    const right = await post(stores, url, "open-sesame");
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/a/Locked01");
    const setCookie = right.headers.get("set-cookie")!;
    expect(setCookie).toContain("Path=/a/Locked01");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");

    const opened = await get(stores, url, cookieFrom(right));
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain("secret revenue");
  });

  it("redirects back to the trailing-slash URL the form was posted from", async () => {
    const stores = await publishProtected();

    const fromSlash = await post(stores, url, "open-sesame", {
      referer: `${url}/`,
    });
    expect(fromSlash.headers.get("location")).toBe("/a/Locked01/");

    const fromElsewhere = await post(stores, url, "open-sesame", {
      referer: "https://evil.example/a/Locked01/",
    });
    expect(fromElsewhere.headers.get("location")).toBe("/a/Locked01");
  });

  it("rejects a forged or tampered unlock cookie", async () => {
    const stores = await publishProtected();
    const right = await post(stores, url, "open-sesame");
    const [name, value] = cookieFrom(right).split("=");

    const forged = await get(stores, url, `${name}=${Date.now()}.not-a-sig`);
    expect(forged.status).toBe(401);

    const [issuedAt, signature] = value!.split(".");
    const tampered = await get(
      stores,
      url,
      `${name}=${Number(issuedAt) + 1}.${signature}`,
    );
    expect(tampered.status).toBe(401);
  });

  it("ends existing unlocks when the password changes, and opens to everyone when it is cleared", async () => {
    const stores = await publishProtected();
    const cookie = cookieFrom(await post(stores, url, "open-sesame"));
    expect((await get(stores, url, cookie)).status).toBe(200);

    const changed = await setPublicationPassword({
      publicationUrl: url,
      password: "new-password",
      metadataStore: stores.metadataStore,
    });
    expect(changed).toMatchObject({ status: "updated", hasPassword: true });
    expect((await get(stores, url, cookie)).status).toBe(401);
    expect((await post(stores, url, "open-sesame")).status).toBe(401);
    expect((await post(stores, url, "new-password")).status).toBe(303);

    const cleared = await setPublicationPassword({
      publicationUrl: url,
      password: null,
      metadataStore: stores.metadataStore,
    });
    expect(cleared).toMatchObject({ status: "updated", hasPassword: false });
    expect((await get(stores, url)).status).toBe(200);
  });

  it("expires an unlock after --unlock-for and sets the cookie lifetime to match", async () => {
    const stores = await publishProtected({ unlockFor: "12h" });
    const publication = await stores.metadataStore.getByOpaqueId("Locked01");
    expect(publication!.unlockTtlMs).toBe(12 * 60 * 60 * 1000);

    const right = await post(stores, url, "open-sesame");
    expect(right.headers.get("set-cookie")).toContain("Max-Age=43200");

    const issued = new Date("2026-11-26T00:00:00.000Z");
    const header = unlockCookie({
      opaqueId: "Locked01",
      passwordHash: publication!.passwordHash!,
      unlockTtlMs: publication!.unlockTtlMs,
      path: "/a/Locked01",
      secure: true,
      now: issued,
    }).split(";")[0]!;
    const check = (now: string) =>
      isUnlocked({
        cookieHeader: header,
        opaqueId: "Locked01",
        passwordHash: publication!.passwordHash!,
        unlockTtlMs: publication!.unlockTtlMs,
        now: new Date(now),
      });
    expect(check("2026-11-26T11:59:00.000Z")).toBe(true);
    expect(check("2026-11-26T12:01:00.000Z")).toBe(false);
  });

  it("locks out a client address after ten wrong passwords, even for the right password", async () => {
    const stores = await publishProtected();
    const attacker = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      expect((await post(stores, url, "guess", attacker)).status).toBe(401);
    }
    const tenth = await post(stores, url, "guess", attacker);
    expect(tenth.status).toBe(429);
    expect(await tenth.text()).toContain("Too many attempts");

    const lockedOut = await post(stores, url, "open-sesame", attacker);
    expect(lockedOut.status).toBe(429);
    expect(lockedOut.headers.get("set-cookie")).toBeNull();

    const otherAddress = await post(stores, url, "open-sesame", {
      "x-forwarded-for": "198.51.100.4",
    });
    expect(otherAddress.status).toBe(303);
  });

  it("keeps refusing POST on a Publication with no password", async () => {
    const stores = await publishProtected({ password: undefined });

    expect((await get(stores, url)).status).toBe(200);
    expect((await post(stores, url, "anything")).status).toBe(405);
  });

  it("keeps the password when the Publication is updated without one", async () => {
    const stores = await publishProtected();

    await writeFile(stores.sourcePath, "<h1>second version</h1>");
    const updated = await publishArtifact(stores.publishInput);
    expect(updated.decision).toBe("updated");

    expect((await get(stores, url)).status).toBe(401);
    const cookie = cookieFrom(await post(stores, url, "open-sesame"));
    expect(await (await get(stores, url, cookie)).text()).toContain(
      "second version",
    );
  });

  it("refuses a password on a PWA Publication, a short password, and --unlock-for without a password", async () => {
    await expect(publishProtected({ password: "abc" })).rejects.toThrow(
      "Password must be 4 to 200 characters.",
    );
    await expect(
      publishProtected({ password: undefined, unlockFor: "7d" }),
    ).rejects.toThrow("--unlock-for needs a password");
    await expect(publishProtected({ unlockFor: "soon" })).rejects.toThrow(
      "--unlock-for takes a duration",
    );

    const stores = await publishProtected({ password: undefined });
    await stores.metadataStore.update("Locked01", { pwa: true });
    await expect(
      setPublicationPassword({
        publicationUrl: url,
        password: "open-sesame",
        metadataStore: stores.metadataStore,
      }),
    ).rejects.toThrow("PWA Publications cannot have a password");
  });

  it("never returns the password hash from the MCP list tool, and sets a password through the MCP tool", async () => {
    const stores = await publishProtected();
    const context = {
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      publicationMetadataStore: stores.metadataStore,
    } as unknown as McpToolContext;
    const tool = (name: string) =>
      artifactsMcpTools.find((spec) => spec.name === name)!;

    const listed = JSON.stringify(
      await tool("list_artifacts").run({}, context),
    );
    expect(listed).toContain('"hasPassword":true');
    expect(listed).not.toContain("scrypt");

    await tool("set_artifact_password").run(
      { publicationUrl: url, clear: true },
      context,
    );
    expect((await get(stores, url)).status).toBe(200);
  });

  it("forwards the Cookie header and the posted form through the Vercel Node adapter", async () => {
    const stores = await publishProtected();
    const call = async (init: {
      method: string;
      body?: string;
      cookie?: string;
    }) => {
      const nodeRequest = Object.assign(
        Readable.from(init.body ? [init.body] : []),
        {
          method: init.method,
          url: "/api/a/Locked01",
          headers: {
            host: "artifacts.thefocus.ai",
            "x-forwarded-proto": "https",
            "content-type": "application/x-www-form-urlencoded",
            ...(init.cookie ? { cookie: init.cookie } : {}),
          },
        },
      ) as unknown as IncomingMessage;
      const headers: Record<string, string> = {};
      let body = "";
      const nodeResponse = {
        statusCode: 0,
        setHeader: (key: string, value: string) => {
          headers[key] = value;
        },
        end: (chunk?: Buffer) => {
          body = chunk?.toString() ?? "";
        },
      };
      await servePublicationNodeRequest(
        nodeRequest,
        nodeResponse as unknown as ServerResponse,
        stores,
      );
      return { status: nodeResponse.statusCode, headers, body };
    };

    const unlock = await call({ method: "POST", body: "password=open-sesame" });
    expect(unlock.status).toBe(303);
    const opened = await call({
      method: "GET",
      cookie: unlock.headers["set-cookie"]!.split(";")[0],
    });
    expect(opened.status).toBe(200);
    expect(opened.body).toContain("secret revenue");
  });
});

describe("Publication password storage in Postgres", () => {
  // Reads each statement the store sends and returns the value bound to a
  // named column, so a column list and its parameters cannot drift apart.
  function recordingSql() {
    const statements: { sql: string; params: unknown[] }[] = [];
    const row = {
      opaque_id: "Locked01",
      publication_url_path: "/a/Locked01",
      publisher_email: "publisher@thefocus.ai",
      status: "active",
      active_manifest_ref: "m",
      active_artifact_locator: "l",
      local_source_path: null,
      revision_window_expires_at: null,
      title: null,
      pwa: false,
      password_hash: "scrypt$stored",
      unlock_ttl_ms: "43200000",
      created_at: "2026-11-26T00:00:00.000Z",
      updated_at: "2026-11-26T00:00:00.000Z",
      removed_at: null,
    };
    return {
      statements,
      async query<T>(sql: string, params: unknown[] = []) {
        statements.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return {
          rows: (sql.includes("count(*)") ? [{ count: "3" }] : [row]) as T[],
        };
      },
    };
  }

  function insertedValue(
    statement: { sql: string; params: unknown[] },
    column: string,
  ) {
    const columns = statement.sql
      .match(/insert into publications \((.*?)\)/)![1]!
      .split(",")
      .map((name) => name.trim());
    return statement.params[columns.indexOf(column)];
  }

  function updatedValue(
    statement: { sql: string; params: unknown[] },
    column: string,
  ) {
    const position = statement.sql.match(
      new RegExp(`${column} = \\$(\\d+)`),
    )![1];
    return statement.params[Number(position) - 1];
  }

  it("binds the password hash and unlock limit to their own columns and reads them back", async () => {
    const sql = recordingSql();
    const store = new PostgresPublicationMetadataStore(sql);

    const created = await store.create({
      opaqueId: "Locked01",
      publisherEmail: "publisher@thefocus.ai",
      activeManifestRef: "m",
      activeArtifactLocator: "l",
      passwordHash: "scrypt$new",
      unlockTtlMs: 3_600_000,
    });
    const insert = sql.statements[0]!;
    expect(insertedValue(insert, "password_hash")).toBe("scrypt$new");
    expect(insertedValue(insert, "unlock_ttl_ms")).toBe(3_600_000);
    expect(insertedValue(insert, "pwa")).toBe(false);
    expect(created.passwordHash).toBe("scrypt$stored");
    expect(created.unlockTtlMs).toBe(43_200_000);

    await store.update("Locked01", { passwordHash: null, unlockTtlMs: null });
    const cleared = sql.statements.at(-1)!;
    expect(updatedValue(cleared, "password_hash")).toBeNull();
    expect(updatedValue(cleared, "unlock_ttl_ms")).toBeNull();

    await store.update("Locked01", { title: "Renamed" });
    const untouched = sql.statements.at(-1)!;
    expect(updatedValue(untouched, "password_hash")).toBe("scrypt$stored");
    expect(updatedValue(untouched, "unlock_ttl_ms")).toBe(43_200_000);
    expect(updatedValue(untouched, "title")).toBe("Renamed");
    expect(updatedValue(untouched, "updated_at")).toBeInstanceOf(Date);
  });

  it("counts and records unlock failures by limit key", async () => {
    const sql = recordingSql();
    const store = new PostgresPublicationMetadataStore(sql, {
      now: () => new Date("2026-11-26T12:00:00.000Z"),
    });
    const since = new Date("2026-11-26T11:59:00.000Z");

    expect(await store.countUnlockFailures("Locked01:203.0.113.9", since)).toBe(
      3,
    );
    expect(sql.statements[0]).toEqual({
      sql: "select count(*) as count from publication_unlock_failures where limit_key = $1 and failed_at >= $2",
      params: ["Locked01:203.0.113.9", since],
    });

    await store.recordUnlockFailure("Locked01:203.0.113.9");
    expect(sql.statements.at(-1)).toEqual({
      sql: "insert into publication_unlock_failures (limit_key, failed_at) values ($1, $2)",
      params: ["Locked01:203.0.113.9", new Date("2026-11-26T12:00:00.000Z")],
    });
  });
});

describe("Publication password CLI", () => {
  function capture() {
    let text = "";
    return {
      stream: { write: (chunk: string) => ((text += chunk), true) },
      text: () => text,
    };
  }

  function fakeApiClient() {
    return {
      whoami: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      setPassword: vi.fn(async (_token: string, publicationUrl: string) => ({
        opaqueId: "Locked01",
        publicationUrl,
        status: "updated" as const,
        hasPassword: true,
        unlockTtlMs: null,
      })),
      publish: vi.fn(async () => ({
        opaqueId: "Locked01",
        publicationUrlPath: "/a/Locked01",
        publicationUrl: url,
        manifestRef: "m",
        activeArtifactLocator: "l",
        revisionWindowExpiresAt: new Date("2026-11-26T00:15:00.000Z"),
        decision: "created" as const,
        artifactPaths: [],
      })),
    };
  }

  const env = { THEFOCUS_ARTIFACTS_TOKEN: "tfai_pub_password" };

  it("passes --password and --unlock-for from publish to the API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-password-cli-"));
    const sourcePath = join(dir, "report.html");
    await writeFile(sourcePath, secretBody);
    const apiClient = fakeApiClient();

    const exitCode = await runCli(
      [
        "publish",
        sourcePath,
        "--password",
        "open-sesame",
        "--unlock-for",
        "7d",
      ],
      { env, configDir: dir, stdout: capture().stream, apiClient },
    );

    expect(exitCode).toBe(0);
    expect(apiClient.publish.mock.calls[0]).toMatchObject([
      "tfai_pub_password",
      sourcePath,
      { password: "open-sesame", unlockFor: "7d" },
    ]);
  });

  it("sets and clears a password with the password command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifacts-password-cli-"));
    const apiClient = fakeApiClient();
    const stdout = capture();

    expect(
      await runCli(["password", url, "--set", "open-sesame"], {
        env,
        configDir: dir,
        stdout: stdout.stream,
        apiClient,
      }),
    ).toBe(0);
    expect(apiClient.setPassword).toHaveBeenLastCalledWith(
      "tfai_pub_password",
      url,
      { password: "open-sesame", unlockFor: undefined },
    );
    expect(stdout.text()).toBe(`Password set on ${url}\n`);

    await runCli(["password", url, "--clear"], {
      env,
      configDir: dir,
      stdout: capture().stream,
      apiClient,
    });
    expect(apiClient.setPassword).toHaveBeenLastCalledWith(
      "tfai_pub_password",
      url,
      { password: null, unlockFor: undefined },
    );

    const stderr = capture();
    expect(
      await runCli(["password", url], {
        env,
        configDir: dir,
        stdout: capture().stream,
        stderr: stderr.stream,
        apiClient,
      }),
    ).toBe(1);
    expect(stderr.text()).toContain("--set <password>, --clear");
    expect(apiClient.setPassword).toHaveBeenCalledTimes(2);
  });
});
