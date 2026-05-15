// PDF parser.
//
// Workers can't run pdf.js or pdfium, and we don't want to ship a
// 5MB WASM into the bundle. The pragmatic path: hand the PDF to
// Cloudflare's AI Gateway "convert" endpoint or a sidecar Worker
// service binding, both of which return plain text. For day-zero
// ingest we accept the document but defer text extraction by
// returning a marker that the consumer can re-enqueue once an
// extractor is configured.
//
// When PDF_EXTRACT_URL is configured (an HTTP endpoint that accepts
// raw bytes and returns text/plain), parsePdf() POSTs to it.
//
// Until then this returns an empty document — the queue consumer
// skips indexing empty parses and just records the document row, so
// the surface is "PDF noted but body not yet indexed" rather than
// dropping the item entirely.

import type { Env } from "../../env";
import type { ParsedDocument } from "../types";

export async function parsePdf(
  env: Env,
  bytes: ArrayBuffer,
  fallbackTitle?: string,
): Promise<ParsedDocument> {
  const url = env.PDF_EXTRACT_URL;
  if (!url) {
    return {
      text: "",
      ...(fallbackTitle ? { title: fallbackTitle } : {}),
    };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: bytes,
    });
    if (!res.ok) {
      return {
        text: "",
        ...(fallbackTitle ? { title: fallbackTitle } : {}),
      };
    }
    const text = await res.text();
    return {
      text: text.trim(),
      ...(fallbackTitle ? { title: fallbackTitle } : {}),
    };
  } catch {
    return {
      text: "",
      ...(fallbackTitle ? { title: fallbackTitle } : {}),
    };
  }
}
