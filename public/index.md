---
title: TheFocus.AI Artifacts
description: Dynamic publishing skill for AI-created HTML Artifacts.
---

# Publish agent-created HTML

Artifacts is a dynamic publishing skill for TheFocus.AI agents. Use it when an agent creates an HTML report, prototype, mockup, visualization, or static bundle and needs to hand a human a stable unlisted URL.

```bash
npx @the-focus-ai/artifacts publish ./artifact.html
npx @the-focus-ai/artifacts publish ./report.html --title "Q2 Results"
npx @the-focus-ai/artifacts publish ./dist --open
pbpaste | npx @the-focus-ai/artifacts publish - --open
```

The CLI prints a Publication URL like:

```text
https://artifacts.thefocus.ai/a/Ab3xY9kQ
```

Share that URL with the user or client. Anyone with the exact URL can view it without logging in, but Publications are not listed publicly and `/a/` URLs are excluded from crawler discovery.

## Agent usage

- Publish a single HTML file when the Artifact is self-contained.
- Publish a directory when the Artifact has CSS, JavaScript, images, or nested pages.
- Pipe HTML output directly into the CLI via stdin (`-`).
- Use the `--open` flag to automatically open the Publication URL in your browser upon completion.
- Use `--title "Report Name"` to assign a human-readable title (visible in `npx @the-focus-ai/artifacts list`).
- Rerun the same publish command shortly after publishing to hotfix the same URL during the rolling Revision Window.
- Use `THEFOCUS_ARTIFACTS_TOKEN=tfai_pub_...` for non-interactive agent sessions.
- Use `npx @the-focus-ai/artifacts remove <Publication URL> --yes` to remove an accidental Publication.
- Run `npx @the-focus-ai/artifacts list` to view your Publications (titles are shown).

## Posture

- No public index
- Publication URLs are unlisted, not private
- Publication paths under `/a/` are intentionally excluded from crawler discovery
- Public service docs may be used by agents as input; published client Artifacts should not be enumerated

[Read llms.txt](/llms.txt) · [Visit TheFocus.AI](https://thefocus.ai/)
