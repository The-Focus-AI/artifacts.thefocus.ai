import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

type PackageJson = {
  name: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  publishConfig?: Record<string, string>;
  scripts?: Record<string, string>;
  types?: string;
  engines?: Record<string, string>;
};

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
}

describe("npm package metadata", () => {
  it("publishes under the documented scoped package name for npx", async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.name).toBe("@thefocus/artifacts");
    expect(packageJson.bin).toEqual({ artifacts: "dist/src/cli.js" });
    expect(packageJson.publishConfig).toMatchObject({ access: "public" });
  });

  it("keeps the published tarball constrained to built package assets", async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.files).toEqual(["dist/src", "README.md"]);
    expect(packageJson.types).toBe("dist/src/index.d.ts");
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./dist/src/index.d.ts",
        default: "./dist/src/index.js",
      },
    });
  });

  it("builds before npm pack or publish so the CLI bin exists", async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.scripts?.prepack).toBe("pnpm run build");
    expect(packageJson.engines?.node).toBe(">=22");
  });
});
