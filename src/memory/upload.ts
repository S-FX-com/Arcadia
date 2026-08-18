// Upload intake for doctrine seeding (capture channel C, §5.5).
//
// Doctrine lives in markdown files on somebody's disk. Before this, getting
// one into Arcadia meant pasting it into a textarea or running
// `wrangler r2 object put` from a laptop — and a seeding path that needs a
// terminal is a seeding path only Shane uses. Uploading the file is the same
// import, minus the laptop.
//
// The rules here are all refusals, and they are loud on purpose: a renamed PDF
// that decodes to mojibake would otherwise burn a run of model calls and land
// nonsense in staging for a human to read past. Free of Cloudflare imports so
// every rule stays directly testable.

import { MARKDOWN_EXTENSIONS } from "./markdown";
import { documentSegment, MAX_DOCUMENT_CHARS } from "./seed-parts";

/** Markdown first; plain text is the same pipeline without the headings. */
export const UPLOAD_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ".txt", ".text"];
/** The file picker's filter. A filter, not a control — every rule is re-checked server-side. */
export const UPLOAD_ACCEPT = [...UPLOAD_EXTENSIONS, "text/markdown", "text/plain"].join(",");

/** Files per submission. Each one is a document with its own extraction run. */
export const MAX_UPLOAD_FILES = 25;
/** One document. Bytes, against MAX_DOCUMENT_CHARS' characters — stageDocument is the backstop. */
export const MAX_FILE_BYTES = MAX_DOCUMENT_CHARS;
/** The whole submission. Held well under the Worker's memory, since formData() buffers it. */
export const MAX_UPLOAD_BYTES = 8_000_000;
/** Long enough for a descriptive filename, short enough to read in the runs table. */
const MAX_NAME_CHARS = 120;

export interface UploadedFile {
  name: string;
  size: number;
  text(): Promise<string>;
}

export interface SkippedUpload {
  name: string;
  reason: string;
}

/**
 * The document name for an uploaded file. Browsers send a bare filename, but a
 * directory upload sends a path and Windows clients have historically sent a
 * full one — a name is a display label and an R2 key segment, never a path.
 */
export function documentNameOf(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  return base.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
}

/** Why this file cannot be seeded, or undefined if it can. */
export function rejectUpload(name: string, size: number): string | undefined {
  if (!name) return "no filename";
  if (!UPLOAD_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
    return `not a markdown or text file (${UPLOAD_EXTENSIONS.join(", ")})`;
  }
  if (size === 0) return "empty file";
  if (size > MAX_FILE_BYTES) {
    return `${Math.round(size / 1000)} KB — the limit is ${Math.round(
      MAX_FILE_BYTES / 1000
    )} KB per file. Split it and upload the pieces.`;
  }
  return undefined;
}

/**
 * A file that decoded as text but is not text. The extension check alone lets
 * through a PDF someone renamed, and the result is a run of extraction calls
 * over replacement characters.
 */
export function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  const sample = text.slice(0, 4_096);
  if (!sample) return false;
  const replacements = (sample.match(/\uFFFD/g) ?? []).length;
  return replacements > 4 && replacements > sample.length * 0.01;
}

/**
 * Make every name unique *as an R2 key segment*, not as a display name — two
 * files named "pricing 2026.md" and "pricing_2026.md" reduce to one segment,
 * and the second would silently overwrite the first's parts.
 */
export function dedupeDocumentNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 2; taken.has(documentSegment(candidate)); n++) candidate = `${stem}-${n}${ext}`;
    taken.add(documentSegment(candidate));
    return candidate;
  });
}
