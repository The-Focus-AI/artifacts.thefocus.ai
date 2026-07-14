// Entry point for the vendored review-editor bundle. Regenerate with
// `pnpm run build:review-editor` after changing dependencies; the output is
// committed at public/vendor/review-editor.js so the Review Link page works
// without any CDN (see ADR 0005: self-contained static editor bundle).
export { EditorView, basicSetup } from "codemirror";
export { markdown } from "@codemirror/lang-markdown";
export { EditorState } from "@codemirror/state";
export { default as MarkdownIt } from "markdown-it";
