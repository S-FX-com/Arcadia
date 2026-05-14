// Plain-text parser. Just normalises whitespace.

import type { ParsedDocument } from "../types";

export function parsePlain(input: string): ParsedDocument {
  const text = input.replace(/\r\n?/g, "\n").trim();
  return { text };
}
