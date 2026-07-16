// Entry point for the vendored review-editor bundle. Regenerate with
// `pnpm run build:review-editor` after changing dependencies; the output is
// committed at public/vendor/review-editor.js so the Review Link page works
// without any CDN (see ADR 0005: self-contained static editor bundle).
export { Editor } from "@tiptap/core";
export { default as StarterKit } from "@tiptap/starter-kit";
export { default as Table } from "@tiptap/extension-table";
export { default as TableRow } from "@tiptap/extension-table-row";
export { default as TableCell } from "@tiptap/extension-table-cell";
export { default as TableHeader } from "@tiptap/extension-table-header";
export { Markdown } from "tiptap-markdown";
export { Plugin, PluginKey } from "@tiptap/pm/state";
export { Decoration, DecorationSet } from "@tiptap/pm/view";
export {
  deriveMarkdownTitle,
  formatFrontMatterFieldValue,
  joinFrontMatter,
  parseFrontMatterData,
  parseFrontMatterFieldValue,
  serializeFrontMatterData,
  splitFrontMatter,
} from "../src/front-matter.ts";
