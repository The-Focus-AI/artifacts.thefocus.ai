/**
 * Rewrite Markdown image targets using an exact relativeRef → hosted URL map.
 * Leaves http(s)/data/mailto/# targets alone (they never appear in the map).
 */
export function rewriteDocAssetMarkdown(
  markdown: string,
  refToHostedUrl: Map<string, string>,
): string {
  if (refToHostedUrl.size === 0) return markdown;
  return markdown.replace(
    /(!\[[^\]]*]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
    (full, prefix: string, target: string, suffix: string) => {
      const hosted = refToHostedUrl.get(target.trim());
      if (!hosted) return full;
      return `${prefix}${hosted}${suffix}`;
    },
  );
}
