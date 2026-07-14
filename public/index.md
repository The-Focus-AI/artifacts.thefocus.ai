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

## Living Docs

When the deliverable is a Markdown document to iterate on with a human — a proposal, spec, or draft — publish it as a Living Doc instead of a static Artifact:

```bash
npx @the-focus-ai/artifacts doc publish ./proposal.md --title "Proposal"
```

This prints a read-only View Link (`/d/{id}`) and an editable Review Link (`/r/{id}`). Hand the Review Link to the human: it opens a WYSIWYG editor where they edit the rendered document directly (autosaved) and attach comments to selected text. On your next turn, pull their feedback and respond with span-anchored Suggestions they accept or reject inline:

```bash
npx @the-focus-ai/artifacts doc pull https://artifacts.thefocus.ai/d/Ab3xY9kQ
echo '{"suggestions":[{"anchorQuote":"exact text","replacement":"new text"}]}' \
  | npx @the-focus-ai/artifacts doc respond https://artifacts.thefocus.ai/d/Ab3xY9kQ
```

Each pull cuts a numbered Version with a diff, so both sides can track the round-trip. Suggestions are never applied automatically.

## Posture

- No public index
- Publication URLs are unlisted, not private
- Publication paths under `/a/` are intentionally excluded from crawler discovery
- Public service docs may be used by agents as input; published client Artifacts should not be enumerated

[Read llms.txt](/llms.txt) · [Visit TheFocus.AI](https://thefocus.ai/)
