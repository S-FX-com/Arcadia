// OneNote parser.
//
// Microsoft Graph returns OneNote page content as HTML. We strip
// OneNote-specific attributes (data-id, data-index, …) and reuse the
// HTML parser. The `<title>` is OneNote's first heading element and
// is preserved via parseHtml() so chunker can keep it as context.

import type { ParsedDocument } from "../types";
import { parseHtml } from "./html";

export function parseOneNote(html: string): ParsedDocument {
  const cleaned = html
    .replace(/data-[\w-]+="[^"]*"/gi, "")
    .replace(/style="[^"]*"/gi, "")
    .replace(/<img\s+[^>]*alt="([^"]*)"[^>]*>/gi, "[image: $1]");
  return parseHtml(cleaned);
}
