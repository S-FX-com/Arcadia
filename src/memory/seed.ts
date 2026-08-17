// Bulk seed — capture channel C (§5.5). The one-time import that gives Arcadia
// doctrine on day one instead of one typed entry at a time: this file, the
// Kamino CLAUDE.md, the Koerner communication directives, brand positioning,
// past proposals, pricing history, Blueprint posts.
//
// It does not extract anything itself. Documents are cut into parts, each part
// is fed through the existing §5.3 pipeline (pass A + mandatory pass B →
// verification → dedupe → conflict check), and everything lands in
// sfx-doctrine-staging.
//
// Staging, never canonical. Doctrine never auto-commits (§5.6.1) — a bulk
// import is exactly the situation that rule exists for, because nobody reads
// two hundred entries as carefully as they read one. A human still ratifies
// every entry from the doctrine surface.

import { getAgentByName } from "agents";
import { DOCTRINE_STAGING, type Message } from "./driver";
import { documentSegment, MAX_DOCUMENT_CHARS, partKey, partsOf, type SeedPart } from "./seed-parts";
import { SelfHostedMemoryDriver } from "./self-hosted";
import {
  dedupeDocumentNames,
  documentNameOf,
  looksBinary,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  rejectUpload,
  type SkippedUpload,
  type UploadedFile,
} from "./upload";

/** R2 prefix holding staged parts, one folder per run. */
export const SEED_RUN_PREFIX = "doctrine-seed/runs";
/** Default prefix operators drop raw documents into for a source="r2" run. */
export const SEED_INBOX_PREFIX = "doctrine-seed/inbox/";
/** Where an uploaded file is kept verbatim, one folder per run. */
export const SEED_UPLOAD_PREFIX = "doctrine-seed/uploads";

export type { SeedPart };

export interface PartConflict {
  topicKey: string;
  existingId: string;
  existingText: string;
  incomingText: string;
}

export interface PartResult {
  written: number;
  duplicates: number;
  conflicts: PartConflict[];
}

/** Write one document's parts into the run folder. Returns the part count. */
export async function stageDocument(
  env: Env,
  runId: string,
  document: string,
  content: string
): Promise<number> {
  if (content.length > MAX_DOCUMENT_CHARS) {
    throw new Error(
      `document "${document}" is ${content.length} characters — the limit is ${MAX_DOCUMENT_CHARS}. Split it and seed the pieces.`
    );
  }
  const parts = partsOf(document, content);
  for (const part of parts) {
    await env.ARTIFACTS.put(partKey(SEED_RUN_PREFIX, runId, document, part.index), JSON.stringify(part));
  }
  return parts.length;
}

/** Every object under a prefix, following the truncation cursor. */
export async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await env.ARTIFACTS.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of listing.objects) keys.push(object.key);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

export async function listRunParts(env: Env, runId: string): Promise<string[]> {
  return listKeys(env, `${SEED_RUN_PREFIX}/${runId}/`);
}

export async function readPart(env: Env, key: string): Promise<SeedPart | null> {
  const object = await env.ARTIFACTS.get(key);
  if (!object) return null;
  return JSON.parse(await object.text()) as SeedPart;
}

/**
 * Copy raw documents from an operator-supplied prefix into the run as parts.
 * Lets a batch be uploaded with `wrangler r2 object put` and seeded without
 * pasting it through a browser.
 */
export async function stageFromR2Prefix(
  env: Env,
  runId: string,
  prefix: string
): Promise<{ documents: string[]; parts: number }> {
  const keys = await listKeys(env, prefix);
  const documents: string[] = [];
  let parts = 0;
  for (const key of keys) {
    const object = await env.ARTIFACTS.get(key);
    if (!object) continue;
    const content = await object.text();
    if (!content.trim()) continue;
    const document = key.slice(prefix.length) || key;
    parts += await stageDocument(env, runId, document, content);
    documents.push(document);
  }
  return { documents, parts };
}

export interface UploadOutcome {
  /** Names as they were staged, after path-stripping and de-collision. */
  documents: string[];
  parts: number;
  /** Every file that did not make it, and why. Never dropped silently. */
  skipped: SkippedUpload[];
}

/**
 * Stage uploaded markdown for a run: keep the original, cut it into parts.
 *
 * The verbatim copy in R2 is the provenance §5.6.4 asks for — a ratifier
 * looking at a candidate six months from now can read the document it came
 * from, and a failed run can be re-seeded without going back to whoever had
 * the file. Refusals are collected rather than thrown: one unreadable file in
 * a batch of twelve should not cost the other eleven their run.
 */
export async function stageUploads(
  env: Env,
  runId: string,
  files: UploadedFile[]
): Promise<UploadOutcome> {
  const skipped: SkippedUpload[] = [];
  const accepted: Array<{ name: string; content: string }> = [];
  let bytes = 0;

  for (const [i, file] of files.entries()) {
    const name = documentNameOf(file.name) || `file-${i + 1}`;

    if (accepted.length + skipped.length >= MAX_UPLOAD_FILES) {
      skipped.push({ name, reason: `over the ${MAX_UPLOAD_FILES}-file limit for one submission` });
      continue;
    }
    const rejection = rejectUpload(name, file.size);
    if (rejection) {
      skipped.push({ name, reason: rejection });
      continue;
    }
    if (bytes + file.size > MAX_UPLOAD_BYTES) {
      skipped.push({ name, reason: "over the size limit for one submission" });
      continue;
    }

    const content = await file.text();
    if (!content.trim()) {
      skipped.push({ name, reason: "no readable text" });
      continue;
    }
    if (looksBinary(content)) {
      skipped.push({ name, reason: "not UTF-8 text — a renamed binary?" });
      continue;
    }

    bytes += file.size;
    accepted.push({ name, content });
  }

  const names = dedupeDocumentNames(accepted.map((f) => f.name));
  const documents: string[] = [];
  let parts = 0;

  for (const [i, file] of accepted.entries()) {
    const name = names[i] ?? file.name;
    try {
      parts += await stageDocument(env, runId, name, file.content);
    } catch (err) {
      skipped.push({ name, reason: err instanceof Error ? err.message : "could not be staged" });
      continue;
    }
    await env.ARTIFACTS.put(`${SEED_UPLOAD_PREFIX}/${runId}/${documentSegment(name)}`, file.content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    documents.push(name);
  }

  return { documents, parts, skipped };
}

/**
 * Push one part through the §5.3 pipeline into staging.
 *
 * The sessionId carries the run and the source document, so every resulting
 * entry's provenance names where it came from (§5.6.4) — a doctrine entry whose
 * origin cannot be traced is one nobody can safely ratify.
 */
export async function ingestPart(env: Env, runId: string, part: SeedPart): Promise<PartResult> {
  const profile = await new SelfHostedMemoryDriver(env).getProfile(DOCTRINE_STAGING);
  const messages: Message[] = part.messages.map((content) => ({ role: "user", content }));
  const result = await profile.ingest(messages, {
    sessionId: `seed:${runId}:${part.document}`,
  });
  return {
    written: result.written.length,
    duplicates: result.duplicates,
    conflicts: result.conflicts.map((c) => ({
      topicKey: c.incoming.topicKey,
      existingId: c.existing.id,
      existingText: c.existing.content,
      incomingText: c.incoming.content,
    })),
  };
}

/** Staging entries awaiting a human tap, newest first. */
export async function stagingQueue(env: Env, limit = 200) {
  const stub = await getAgentByName(env.MemoryProfile, DOCTRINE_STAGING);
  return stub.listMemories({ limit });
}
