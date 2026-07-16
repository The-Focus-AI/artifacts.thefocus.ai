import Table from "@tiptap/extension-table";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

type MarkdownSerializeState = {
  inTable: boolean;
  write: (text: string) => void;
  ensureNewLine: () => void;
  closeBlock: (node: ProseMirrorNode) => void;
  renderInline: (node: ProseMirrorNode) => void;
  render: (node: ProseMirrorNode) => void;
};

/**
 * TipTap Table with Markdown serialization that keeps images in cells.
 * Upstream tiptap-markdown skips a cell when `textContent` is empty, which
 * drops image-only cells like `| ![alt](src) |`.
 */
export const ReviewTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializeState, node: ProseMirrorNode) {
          state.inTable = true;
          node.forEach(
            (row: ProseMirrorNode, _rowPos: number, rowIndex: number) => {
              state.write("| ");
              row.forEach(
                (
                  cell: ProseMirrorNode,
                  _cellPos: number,
                  cellIndex: number,
                ) => {
                  if (cellIndex) state.write(" | ");
                  cell.forEach(
                    (
                      child: ProseMirrorNode,
                      _childPos: number,
                      childIndex: number,
                    ) => {
                      if (childIndex) state.write(" ");
                      if (child.isTextblock) {
                        state.renderInline(child);
                      } else if (child.type.name === "image") {
                        writeImage(state, child);
                      } else {
                        state.render(child);
                      }
                    },
                  );
                },
              );
              state.write(" |");
              state.ensureNewLine();
              if (!rowIndex) {
                const delimiterRow = Array.from({ length: row.childCount })
                  .map(() => "---")
                  .join(" | ");
                state.write(`| ${delimiterRow} |`);
                state.ensureNewLine();
              }
            },
          );
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {
          // markdown-it emits <table> HTML; TipTap parses it.
        },
      },
    };
  },
}).configure({ resizable: false });

function writeImage(
  state: Pick<MarkdownSerializeState, "write">,
  node: ProseMirrorNode,
) {
  const alt = node.attrs.alt ?? "";
  const src = node.attrs.src ?? "";
  const title = node.attrs.title ? ` "${node.attrs.title}"` : "";
  state.write(`![${alt}](${src}${title})`);
}
