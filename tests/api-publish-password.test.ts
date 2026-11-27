import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// The handler builds its own Neon and Vercel Blob stores. Swap them for
// in-memory ones shared with the test.
const shared = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("../src/storage/publication-metadata.js", async (original) => {
  const actual =
    await original<typeof import("../src/storage/publication-metadata.js")>();
  shared.metadataStore = new actual.InMemoryPublicationMetadataStore();
  return {
    ...actual,
    createNeonPublicationMetadataStore: () => shared.metadataStore,
  };
});
vi.mock("../src/storage/artifact-content.js", async (original) => {
  const actual =
    await original<typeof import("../src/storage/artifact-content.js")>();
  return {
    ...actual,
    VercelBlobArtifactContentStore: actual.InMemoryArtifactContentStore,
  };
});
vi.mock("../src/auth.js", async (original) => {
  const actual = await original<typeof import("../src/auth.js")>();
  shared.tokenStore = new actual.InMemoryPublisherTokenStore();
  return { ...actual, createNeonPublisherTokenStore: () => shared.tokenStore };
});

import { handleArtifactsApiRequest } from "../api/artifacts.js";
import {
  InMemoryPublisherTokenStore,
  issuePublisherToken,
} from "../src/auth.js";
import { prepareArtifactUpload } from "../src/publication.js";
import { artifactUploadForm } from "../src/remote-api.js";

describe("publish over the hosted API", () => {
  it("copies the password from the Publication URL named in keepPasswordFrom", async () => {
    const { token } = await issuePublisherToken({
      email: "publisher@thefocus.ai",
      store: shared.tokenStore as InMemoryPublisherTokenStore,
    });
    const dir = await mkdtemp(join(tmpdir(), "artifacts-api-password-"));
    const sourcePath = join(dir, "report.html");
    await writeFile(sourcePath, "<h1>report</h1>");
    const upload = await prepareArtifactUpload(sourcePath);
    const publish = async (options: Parameters<typeof artifactUploadForm>[1]) =>
      (await (
        await handleArtifactsApiRequest(
          new Request(
            "https://artifacts.thefocus.ai/api/artifacts?action=publish",
            {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
              body: artifactUploadForm(upload, options),
            },
          ),
        )
      ).json()) as { publicationUrl: string; hasPassword: boolean };

    const first = await publish({ password: "open-sesame" });
    expect(first.hasPassword).toBe(true);

    const kept = await publish({ keepPasswordFrom: first.publicationUrl });
    expect(kept.publicationUrl).not.toBe(first.publicationUrl);
    expect(kept.hasPassword).toBe(true);

    const fresh = await publish({});
    expect(fresh.hasPassword).toBe(false);
  });
});
