import { describe, expect, it } from "vitest";

import {
  deriveMarkdownTitle,
  joinFrontMatter,
  markdownBody,
  publishLivingDoc,
  rewriteDocAssetMarkdown,
  serveLivingDocViewRequest,
  splitFrontMatter,
  titleFromFrontMatter,
  InMemoryDocAssetContentStore,
  InMemoryLivingDocMetadataStore,
} from "../src/index.js";

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
  });

  it("does not treat a leading horizontal rule as front matter", () => {
    const markdown = "---\n\n# After a rule\n";
    expect(splitFrontMatter(markdown)).toEqual({
      matter: null,
      body: markdown,
    });
  });

  it("prefers front-matter title over body heading", () => {
    expect(
      deriveMarkdownTitle(`---
title: From Matter
---
# From Heading
`),
    ).toBe("From Matter");
    expect(titleFromFrontMatter("title: Hello")).toBe("Hello");
    expect(titleFromFrontMatter('title: "Quoted"')).toBe("Quoted");
  });

  it("exposes the body for rendering only", () => {
    expect(
      markdownBody(`---
title: Hidden
---
Visible
`),
    ).toBe("Visible\n");
  });
});

describe("front matter on publish", () => {
  it("keeps YAML front matter when rewriting Doc Asset image URLs", () => {
    const markdown = `---
title: Card deck
status: draft
---
# Cards

![dot](./assets/dot.png)
`;
    const rewritten = rewriteDocAssetMarkdown(
      markdown,
      new Map([["./assets/dot.png", "https://host/d/id/assets/dot.png"]]),
    );
    expect(
      rewritten.startsWith("---\ntitle: Card deck\nstatus: draft\n---\n"),
    ).toBe(true);
    expect(rewritten).toContain("![dot](https://host/d/id/assets/dot.png)");
    expect(rewritten).not.toContain("./assets/dot.png");
  });

  it("stores front matter on publish and omits YAML fences from View HTML", async () => {
    const store = new InMemoryLivingDocMetadataStore();
    const contentStore = new InMemoryDocAssetContentStore();
    const markdown = `---
title: From Front Matter
---
# Heading

![dot](./dot.png)
`;

    const published = await publishLivingDoc({
      markdown,
      publisherEmail: "publisher@thefocus.ai",
      publicBaseUrl: "https://artifacts.thefocus.ai",
      store,
      contentStore,
      opaqueId: "fmDoc1",
      reviewId: "fmReview1",
      assets: [
        {
          relativeRef: "./dot.png",
          assetPath: "dot.png",
          contentType: "image/png",
          data: Buffer.from([1, 2, 3]),
        },
      ],
    });

    expect(published.title).toBe("From Front Matter");
    const doc = await store.getByOpaqueId("fmDoc1");
    expect(doc?.currentMarkdown).toMatch(
      /^---\ntitle: From Front Matter\n---\n/,
    );
    expect(doc?.currentMarkdown).toContain(
      "https://artifacts.thefocus.ai/d/fmDoc1/dot.png",
    );

    const view = await serveLivingDocViewRequest({
      request: new Request("https://artifacts.thefocus.ai/d/fmDoc1"),
      store,
      contentStore,
    });
    const html = await view.text();
    expect(html).toContain("From Front Matter");
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).not.toContain("title: From Front Matter");
  });
});
