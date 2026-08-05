import { describe, expect, it } from "vitest";
import { structuralDiagnoses, type CrawlResult } from "../src/site/plan";

type CrawledPage = CrawlResult["pages"][number];
type PageOverride = Partial<Omit<CrawledPage, "metaDescription">> & {
  metaDescription?: string | undefined;
};

const page = (over: PageOverride): CrawledPage => {
  const { metaDescription = "A description", ...rest } = over;
  return {
    url: "https://example.com/",
    title: "Home",
    h1: ["Home"],
    h2: [],
    wordCount: 800,
    internalLinksOut: [],
    status: 200,
    ...rest,
    ...(metaDescription !== undefined ? { metaDescription } : {}),
  };
};

const crawl = (over: Partial<CrawlResult>): CrawlResult => ({
  pages: [page({})],
  orphans: [],
  depth: { "https://example.com/": 0 },
  skipped: [],
  ...over,
});

describe("structural diagnoses (§4 Phase 4)", () => {
  it("attaches reasoning to every finding — the hard requirement", () => {
    const found = structuralDiagnoses(
      crawl({
        orphans: ["https://example.com/orphan"],
        depth: { "https://example.com/deep": 5 },
        pages: [
          page({ url: "https://example.com/thin", wordCount: 40 }),
          page({ url: "https://example.com/gone", status: 404 }),
          page({ url: "https://example.com/nometa", metaDescription: undefined }),
          page({ url: "https://example.com/two-h1", h1: ["One", "Two"] }),
        ],
      })
    );
    expect(found.length).toBeGreaterThan(0);
    for (const d of found) {
      expect(d.why.trim().length).toBeGreaterThan(15);
      // Reasoning must be specific, not an appeal to authority.
      expect(d.why.toLowerCase()).not.toContain("best practice");
      expect(d.why.toLowerCase()).not.toContain("industry standard");
    }
  });

  it("finds orphans", () => {
    const found = structuralDiagnoses(crawl({ orphans: ["https://example.com/orphan"] }));
    expect(found.some((d) => d.finding.includes("orphan"))).toBe(true);
  });

  it("flags pages more than three clicks deep", () => {
    const found = structuralDiagnoses(crawl({ depth: { a: 4 } }));
    expect(found.some((d) => d.finding.includes("3 clicks"))).toBe(true);
  });

  it("flags thin pages but not healthy ones", () => {
    expect(
      structuralDiagnoses(crawl({ pages: [page({ wordCount: 40 })] })).some((d) => d.finding.includes("thin"))
    ).toBe(true);
    expect(
      structuralDiagnoses(crawl({ pages: [page({ wordCount: 900 })] })).some((d) => d.finding.includes("thin"))
    ).toBe(false);
  });

  it("finds duplicated intent across pages with the same subject", () => {
    const found = structuralDiagnoses(
      crawl({
        pages: [
          page({ url: "https://example.com/a", title: "Managed IT Support Services" }),
          page({ url: "https://example.com/b", title: "Managed IT Support Services Near Me" }),
        ],
      })
    );
    expect(found.some((d) => d.finding.includes("same subject"))).toBe(true);
  });

  it("reports a clean site as clean", () => {
    expect(structuralDiagnoses(crawl({}))).toEqual([]);
  });

  it("ranks broken pages and orphans as high severity", () => {
    const found = structuralDiagnoses(
      crawl({ orphans: ["https://example.com/x"], pages: [page({ status: 500 })] })
    );
    expect(found.filter((d) => d.severity === "high").length).toBeGreaterThanOrEqual(2);
  });
});
