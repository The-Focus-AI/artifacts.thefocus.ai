/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import Image from "@tiptap/extension-image";
import { Markdown } from "tiptap-markdown";
import { ReviewTable } from "../scripts/review-table.js";

function createReviewEditor(markdown: string) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit,
      ReviewTable,
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: true }),
      Markdown.configure({ html: false, linkify: true }),
    ],
    content: markdown,
  });
}

describe("review editor markdown tables and images", () => {
  it("parses and serializes a GFM table", () => {
    const markdown = `| Skill | Role |
| --- | --- |
| grill-me | challenge plans |
| to-prd | write PRDs |
`;
    const editor = createReviewEditor(markdown);
    try {
      const json = editor.getJSON();
      expect(json.content?.some((node) => node.type === "table")).toBe(true);
      const out = editor.storage.markdown.getMarkdown() as string;
      expect(out).toContain("| Skill | Role |");
      expect(out).toContain("| grill-me | challenge plans |");
      expect(out).toContain("| to-prd | write PRDs |");
    } finally {
      editor.destroy();
    }
  });

  it("keeps images inside table cells through a markdown round-trip", () => {
    const markdown = `| Skill | Card |
| --- | --- |
| A | ![A](../assets/cards/a.jpg) |
`;
    const editor = createReviewEditor(markdown);
    try {
      const json = JSON.stringify(editor.getJSON());
      expect(json).toContain('"type":"image"');
      expect(json).toContain("../assets/cards/a.jpg");
      const out = editor.storage.markdown.getMarkdown() as string;
      expect(out).toContain("![A](../assets/cards/a.jpg)");
    } finally {
      editor.destroy();
    }
  });

  it("keeps inline images in paragraphs", () => {
    const markdown = `See ![hero](https://example.com/hero.png) here.\n`;
    const editor = createReviewEditor(markdown);
    try {
      const out = editor.storage.markdown.getMarkdown() as string;
      expect(out).toContain("![hero](https://example.com/hero.png)");
    } finally {
      editor.destroy();
    }
  });
});
