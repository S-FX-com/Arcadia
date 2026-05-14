// HTML parser.
//
// Workers don't have DOM, so we use a small structural regex pass:
//   - drop <script>/<style>/<head> content
//   - collapse <br> / <p>/<div>/<li> boundaries into newlines
//   - decode the common entity set
//   - lift <h1>-<h6> as section headings when present
//
// Good enough for Teams message bodies, SharePoint pages, and
// OneNote-rendered HTML.

import type { ParsedDocument } from "../types";

export function parseHtml(html: string): ParsedDocument {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, "[[TITLE:$1]]");

  // Pull title if present.
  const titleMatch = stripped.match(/\[\[TITLE:([\s\S]*?)\]\]/);
  const title = titleMatch?.[1]?.trim() ?? undefined;

  // Pull sections.
  const sections: { heading?: string; text: string }[] = [];
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings: { index: number; level: number; text: string }[] = [];
  for (const m of stripped.matchAll(headingRe)) {
    if (typeof m.index !== "number") continue;
    headings.push({
      index: m.index,
      level: Number(m[1] ?? "1"),
      text: stripTags(m[2] ?? ""),
    });
  }
  if (headings.length > 0) {
    for (let i = 0; i < headings.length; i += 1) {
      const head = headings[i]!;
      const nextIndex = headings[i + 1]?.index ?? stripped.length;
      const slice = stripped.slice(head.index, nextIndex);
      const text = slice
        .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/i, "")
        .trim();
      sections.push({ heading: head.text, text: toPlain(text) });
    }
  }

  const text = toPlain(stripped);
  return {
    text,
    ...(title ? { title } : {}),
    ...(sections.length > 0 ? { sections } : {}),
  };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function toPlain(html: string): string {
  return html
    .replace(/\[\[TITLE:[\s\S]*?\]\]/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
