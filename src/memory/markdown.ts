// Markdown structure for the bulk seed (capture channel C, §5.5).
//
// Doctrine arrives as markdown — this file, the Kamino CLAUDE.md, the Koerner
// communication directives, brand positioning, Blueprint posts. Cutting it on
// blank lines alone throws away the one thing markdown hands us for free:
// every paragraph sits under a heading that names its subject. "Never quote a
// discount" under "## Pricing" is doctrine; the same sentence split two
// messages away from its heading is a statement about nothing, and §5.3 asks
// every extracted memory to still make sense a year from now with no
// surrounding context.
//
// So this file finds the headings. seed-parts.ts turns them into the context
// line each message carries. Free of Cloudflare imports, like seed-parts.ts,
// so the parsing stays directly unit-testable — content loss here is doctrine
// that never reaches staging and that nobody knows to look for.

/** Extensions that get heading-aware treatment. Everything else is plain text. */
export const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

export function isMarkdown(document: string): boolean {
  const name = document.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Between crumbs. Not ">" — that is markdown's blockquote marker. */
export const CRUMB_SEPARATOR = " › ";

export interface MarkdownSection {
  /** Heading path from the top of the document down to this section. */
  path: string[];
  /** The prose under that heading, headings themselves excluded. */
  body: string;
}

export interface FrontMatter {
  /** Simple `key: value` pairs from the YAML block, lowercased keys. */
  fields: Record<string, string>;
  /** Everything after the closing delimiter. */
  body: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FIELD = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

function normalize(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * Split a YAML front-matter block off the top.
 *
 * The fields are document plumbing — layout, tags, draft flags — and seeding
 * them produces entries like "layout is post", which is exactly the noise a
 * ratifier then has to read past. Only `title` survives, as the root of the
 * heading path.
 *
 * Both refusals below exist for the same reason: a document that merely opens
 * with a horizontal rule looks exactly like one that opens with front matter,
 * and reading prose as YAML deletes it. Anything that is not unambiguously a
 * field block stays body — better a few odd candidates than a silently
 * missing first section.
 */
export function splitFrontMatter(content: string): FrontMatter {
  const text = normalize(content);
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: {}, body: text };

  const close = lines.findIndex((line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."));
  if (close === -1) return { fields: {}, body: text };

  const between = lines.slice(1, close).filter((line) => line.trim());
  const yamlish = (line: string) => FIELD.test(line.trim()) || /^\s/.test(line) || /^-\s/.test(line.trim());
  if (between.length === 0 || !between.every(yamlish)) return { fields: {}, body: text };

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const match = FIELD.exec(line.trim());
    if (!match) continue;
    const [, key = "", raw = ""] = match;
    const value = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (key && value) fields[key.toLowerCase()] = value;
  }
  return { fields, body: lines.slice(close + 1).join("\n") };
}

/**
 * Cut a document at its ATX headings, carrying the heading path down.
 *
 * Fenced code is skipped over: a shell comment starting with `#` inside a
 * ``` block is not a heading, and treating it as one splits a command in half
 * and files the rest of the document under it. Setext headings (`===`
 * underlines) are not recognized — they are rare in the S-FX corpus, and
 * `---` is ambiguous with a horizontal rule.
 */
export function sectionsOf(body: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let path: string[] = [];
  let buffer: string[] = [];
  let fence: string | undefined;

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) sections.push({ path: [...path], body: text });
    buffer = [];
  };

  for (const line of normalize(body).split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "`").slice(0, 1);
      if (fence === undefined) fence = marker;
      else if (fence === marker) fence = undefined;
      buffer.push(line);
      continue;
    }

    const heading = fence === undefined ? ATX_HEADING.exec(line) : null;
    const title = heading?.[2]?.trim();
    if (!heading || !title) {
      buffer.push(line);
      continue;
    }

    flush();
    const level = (heading[1] ?? "#").length;
    path = path.slice(0, level - 1);
    // A document that jumps h1 → h3 leaves a hole; keep the depth honest and
    // drop the blanks when the crumb is rendered.
    while (path.length < level - 1) path.push("");
    path.push(title);
  }

  flush();
  return sections;
}

/**
 * The context line a message carries: document, then the headings above it.
 * Trimmed from the outside in when it runs long — the nearest heading is the
 * one that names the subject, and the document name is what makes a candidate
 * traceable, so those two are the last to go.
 */
export function breadcrumb(document: string, path: string[], limit: number): string {
  const crumbs = [document, ...path]
    .map((crumb) => crumb.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (crumbs.length === 0) return "";

  let line = crumbs.join(CRUMB_SEPARATOR);
  while (line.length > limit && crumbs.length > 1) {
    crumbs.splice(1, 1);
    line = crumbs.join(CRUMB_SEPARATOR);
  }
  return line.slice(0, limit);
}
