import { lstat, readFile } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export const maxDocAssetFileBytes = 25 * 1024 * 1024;
export const maxDocAssetTotalBytes = 100 * 1024 * 1024;
export const maxDocAssetFileCount = 1000;

const imageExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

const markdownImageRefRe = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export interface CollectedDocAsset {
  /** Exact path string from the Markdown image target. */
  relativeRef: string;
  absolutePath: string;
  /** Hosted path under /d/{opaqueId}/… (no `..` segments). */
  assetPath: string;
  size: number;
}

export interface CollectDocAssetsResult {
  assets: CollectedDocAsset[];
  missing: string[];
}

export interface CollectDocAssetsInput {
  markdown: string;
  markdownPath: string;
  force?: boolean;
}

/**
 * Find relative Markdown image refs and resolve them on disk for Doc Asset upload.
 */
export async function collectDocAssets(
  input: CollectDocAssetsInput,
): Promise<CollectDocAssetsResult> {
  const markdownDir = dirname(resolve(input.markdownPath));
  const refs = [...new Set(extractRelativeImageRefs(input.markdown))];
  const assets: CollectedDocAsset[] = [];
  const missing: string[] = [];
  const seenAssetPaths = new Set<string>();

  for (const relativeRef of refs) {
    if (isAbsolute(relativeRef) || /^[a-zA-Z]:[\\/]/.test(relativeRef)) {
      throw new Error(
        `Doc Asset path must be relative (got absolute path: ${relativeRef})`,
      );
    }

    const absolutePath = resolve(markdownDir, relativeRef);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      missing.push(relativeRef);
      continue;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`Doc Asset symlinks are not supported: ${relativeRef}`);
    }
    if (!stats.isFile()) {
      missing.push(relativeRef);
      continue;
    }

    const ext = extname(absolutePath).toLowerCase();
    if (!imageExtensions.has(ext)) {
      throw new Error(
        `Doc Asset must be an image file (got ${ext || "no extension"}): ${relativeRef}`,
      );
    }

    if (stats.size > maxDocAssetFileBytes) {
      throw new Error(
        `Doc Asset ${relativeRef} exceeds the 25 MB single-file limit.`,
      );
    }

    const assetPath = toHostedAssetPath(markdownDir, absolutePath);
    if (seenAssetPaths.has(assetPath)) {
      // Same file via another ref — keep first mapping; rewrite handles both refs.
      assets.push({
        relativeRef,
        absolutePath,
        assetPath,
        size: stats.size,
      });
      continue;
    }
    seenAssetPaths.add(assetPath);
    assets.push({
      relativeRef,
      absolutePath,
      assetPath,
      size: stats.size,
    });
  }

  const uniqueFiles = new Map<string, CollectedDocAsset>();
  for (const asset of assets) {
    uniqueFiles.set(asset.assetPath, asset);
  }
  if (uniqueFiles.size > maxDocAssetFileCount) {
    throw new Error(
      `Living Doc has ${uniqueFiles.size} Doc Assets and exceeds the 1,000 file limit.`,
    );
  }
  const totalSize = [...uniqueFiles.values()].reduce(
    (sum, file) => sum + file.size,
    0,
  );
  if (totalSize > maxDocAssetTotalBytes) {
    throw new Error(
      `Living Doc Doc Assets total size exceeds the 100 MB total limit.`,
    );
  }

  if (missing.length > 0 && !input.force) {
    throw new Error(
      `Missing Doc Asset file(s):\n${missing.map((path) => `  - ${path}`).join("\n")}\nRe-run with --force to publish without them.`,
    );
  }

  const present = assets.filter(
    (asset) => !missing.includes(asset.relativeRef),
  );
  return { assets: present, missing };
}

export function extractRelativeImageRefs(markdown: string): string[] {
  const refs: string[] = [];
  for (const match of markdown.matchAll(markdownImageRefRe)) {
    const target = match[1]?.trim();
    if (!target) continue;
    if (/^(https?:|data:|mailto:|#)/i.test(target)) continue;
    refs.push(target);
  }
  return refs;
}

/** Encode a filesystem-relative path as a URL-safe assetPath (no `..`). */
export function toHostedAssetPath(
  markdownDir: string,
  absoluteFilePath: string,
): string {
  const rel = relative(markdownDir, absoluteFilePath);
  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  const encoded = segments.map((segment) =>
    segment === ".." ? "__parent__" : segment,
  );
  if (encoded.length === 0 || encoded.some((s) => s === ".")) {
    throw new Error(`Could not derive Doc Asset path for ${absoluteFilePath}`);
  }
  return encoded.join("/");
}

export async function readCollectedDocAsset(
  asset: CollectedDocAsset,
): Promise<Buffer> {
  return readFile(asset.absolutePath);
}
