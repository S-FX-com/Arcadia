// Ingest pipeline types.
//
// The pipeline is queue-driven. Producers (cron-driven Graph delta
// walkers, subscription webhooks, manual triggers) enqueue
// IngestMessages. The queue-consumer picks them up, parses the
// payload, chunks the text, embeds the chunks, and writes documents +
// document_chunks rows + Vectorize vectors.

export type IngestSource =
  | "teams_message"
  | "teams_channel_message"
  | "chat_message"
  | "drive_item"
  | "sharepoint_page"
  | "onenote_page"
  | "calendar_event"
  | "manual";

export interface IngestMessage {
  source: IngestSource;
  resourceId: string;
  /** Optional URL — used to fetch the body when payload isn't inline. */
  uri?: string;
  /** Optional inline body — saves a round-trip when producers already had it. */
  body?: { content: string; contentType: "text" | "html" | "pdf" | "onenote" };
  title?: string;
  ownerAadId?: string;
  mimeType?: string;
  etag?: string;
  sensitivityLabel?: string;
  lastModifiedAt?: string;
  /** Optional ACL scope to attach to this document, e.g. channel:<id>. */
  scope?: { resourceType: string; resourceId: string };
  /** Source resource metadata for traceability. */
  meta?: Record<string, string | number | boolean | null>;
}

export interface ParsedDocument {
  /** Plain text body. Parsers strip formatting before returning. */
  text: string;
  /** Optional title surfaced from the document body if present. */
  title?: string;
  /** Optional sections produced by structural parsers (OneNote, PDF). */
  sections?: { heading?: string; text: string }[];
}

export interface Chunk {
  ordinal: number;
  text: string;
}
