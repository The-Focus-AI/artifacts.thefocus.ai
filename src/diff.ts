export type DiffOp = "context" | "add" | "remove";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/**
 * Compute a line-oriented diff between two Markdown snapshots using a longest
 * common subsequence. Kept dependency-free and small; it exists to show a
 * Reviewer's changes between two Living Doc Versions, not to be a full patch
 * format.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const lcs = longestCommonSubsequence(beforeLines, afterLines);

  const result: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  for (const common of lcs) {
    while (
      beforeIndex < beforeLines.length &&
      beforeLines[beforeIndex] !== common
    ) {
      result.push({ op: "remove", text: beforeLines[beforeIndex] });
      beforeIndex += 1;
    }
    while (
      afterIndex < afterLines.length &&
      afterLines[afterIndex] !== common
    ) {
      result.push({ op: "add", text: afterLines[afterIndex] });
      afterIndex += 1;
    }
    result.push({ op: "context", text: common });
    beforeIndex += 1;
    afterIndex += 1;
  }
  while (beforeIndex < beforeLines.length) {
    result.push({ op: "remove", text: beforeLines[beforeIndex] });
    beforeIndex += 1;
  }
  while (afterIndex < afterLines.length) {
    result.push({ op: "add", text: afterLines[afterIndex] });
    afterIndex += 1;
  }
  return result;
}

/** Render a diff as a unified-style text block ( `+`/`-`/` ` prefixes ). */
export function formatUnifiedDiff(before: string, after: string): string {
  return diffLines(before, after)
    .map((line) => `${prefixFor(line.op)}${line.text}`)
    .join("\n");
}

export function hasChanges(before: string, after: string): boolean {
  return before !== after;
}

function prefixFor(op: DiffOp): string {
  if (op === "add") return "+";
  if (op === "remove") return "-";
  return " ";
}

function splitLines(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const rows = a.length;
  const cols = b.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const sequence: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      sequence.push(a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return sequence;
}
