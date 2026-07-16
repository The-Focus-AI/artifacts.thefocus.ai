/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { Markdown } from "tiptap-markdown";

function createReviewEditor(markdown: string) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ html: false, linkify: true }),
    ],
    content: markdown,
  });
}

describe("review editor markdown tables", () => {
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
});
