import { describe, expect, it } from "vitest";

import {
  deriveMarkdownTitle,
  formatFrontMatterFieldValue,
  joinFrontMatter,
  markdownBody,
  parseFrontMatterData,
  parseFrontMatterFieldValue,
  serializeFrontMatterData,
  splitFrontMatter,
  titleFromFrontMatter,
} from "../src/front-matter.js";

describe("front matter", () => {
  it("splits and joins YAML front matter without reformatting", () => {
    const markdown = `---
title: Proposal
tags:
  - draft
---
# Heading

Body text.
`;
    const { matter, body } = splitFrontMatter(markdown);
    expect(matter).toBe("title: Proposal\ntags:\n  - draft");
    expect(body).toBe("# Heading\n\nBody text.\n");
    expect(joinFrontMatter(matter, body)).toBe(markdown);
  });

  it("treats documents without fences as body-only", () => {
    expect(splitFrontMatter("# Just a heading\n")).toEqual({
      matter: null,
      body: "# Just a heading\n",
    });
    expect(joinFrontMatter(null, "# Just a heading\n")).toBe(
      "# Just a heading\n",
    );
  });

  it("does not treat a leading horizontal rule as front matter", () => {
    const markdown = "---\n\n# After a rule\n";
    expect(splitFrontMatter(markdown)).toEqual({
      matter: null,
      body: markdown,
    });
  });

  it("drops empty matter when joining", () => {
    expect(joinFrontMatter("  \n", "# Body\n")).toBe("# Body\n");
  });

  it("parses title from front matter and ignores fences for body title", () => {
    expect(
      deriveMarkdownTitle(`---
title: From Matter
---
# From Heading
`),
    ).toBe("From Matter");

    expect(
      deriveMarkdownTitle(`---
status: draft
---
# From Heading
`),
    ).toBe("From Heading");

    expect(deriveMarkdownTitle("---\nstatus: draft\n---\n")).toBeNull();
    expect(titleFromFrontMatter("title: Hello")).toBe("Hello");
    expect(parseFrontMatterData("title: Hello")).toEqual({ title: "Hello" });
  });

  it("exposes the body for rendering", () => {
    expect(
      markdownBody(`---
title: Hidden
---
Visible
`),
    ).toBe("Visible\n");
  });

  it("round-trips structured field values", () => {
    const data = {
      title: "Proposal",
      draft: true,
      count: 3,
      tags: ["a", "b"],
    };
    const matter = serializeFrontMatterData(data);
    expect(parseFrontMatterData(matter)).toEqual(data);
    expect(formatFrontMatterFieldValue(data.tags)).toContain("a");
    expect(parseFrontMatterFieldValue("true")).toBe(true);
    expect(parseFrontMatterFieldValue("[a, b]")).toEqual(["a", "b"]);
  });
});
