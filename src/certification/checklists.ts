// Launch checklists (§4 M2). Items are concrete and certifiable — never
// "check your work." Each item names the verifier Arcadia runs independently,
// so a signature she can disprove becomes a false-certification event.

export type VerifierKind =
  | "links" // crawl every link, report non-200s
  | "spellcheck" // spell/grammar pass on rendered text
  | "mobile" // render at 390px, look for overflow
  | "meta" // title + meta description present
  | "forms" // partial — detects forms and required attributes
  | "copy_diff" // partial — diff rendered copy against the approved source
  | "none"; // human-only; Arcadia cannot verify this one

export interface ChecklistItem {
  key: string;
  label: string;
  verifier: VerifierKind;
  /** Partial verifiers can fail a signature but cannot confirm one. */
  partial?: boolean;
}

export interface ChecklistDef {
  key: string;
  label: string;
  /** Stages this checklist gates, in order (Phase 3 enforces the sequence). */
  stages: string[];
  /** True when the checklist needs a target URL to verify anything. */
  needsUrl: boolean;
  items: ChecklistItem[];
}

export const CHECKLISTS: ChecklistDef[] = [
  {
    key: "web_build",
    label: "Web build",
    stages: ["qa", "tech_review", "pre_launch"],
    needsUrl: true,
    items: [
      { key: "no_typos", label: "No typos in headings or body copy", verifier: "spellcheck" },
      { key: "links_resolve", label: "All links resolve (no 404s)", verifier: "links" },
      { key: "mobile_390", label: "Tested at mobile width (390px)", verifier: "mobile" },
      { key: "forms_deliver", label: "Forms submit and deliver to the right inbox", verifier: "forms", partial: true },
      { key: "meta_present", label: "Meta title and description present", verifier: "meta" },
      { key: "copy_matches", label: "Copy matches the approved document", verifier: "copy_diff", partial: true },
      { key: "images_alt", label: "Every image has meaningful alt text", verifier: "none" },
      { key: "analytics", label: "Analytics and conversion tracking fire", verifier: "none" },
    ],
  },
  {
    key: "seo_deliverable",
    label: "SEO deliverable",
    stages: ["qa", "tech_review"],
    needsUrl: true,
    items: [
      { key: "meta_present", label: "Meta title and description present and within length", verifier: "meta" },
      { key: "links_resolve", label: "All internal and external links resolve", verifier: "links" },
      { key: "no_typos", label: "No typos in the deliverable", verifier: "spellcheck" },
      { key: "keyword_intent", label: "Target keyword matches page intent", verifier: "none" },
      { key: "no_cannibalization", label: "Does not cannibalize an existing page", verifier: "none" },
    ],
  },
  {
    key: "social_post",
    label: "Social post",
    stages: ["qa"],
    needsUrl: false,
    items: [
      { key: "no_typos", label: "No typos in the copy", verifier: "spellcheck" },
      { key: "links_resolve", label: "Every link in the post resolves", verifier: "links" },
      { key: "brand_terms", label: "Uses 'fractional technology department' — never MSP/agency/vendor", verifier: "none" },
      { key: "asset_sized", label: "Image or video sized correctly for the platform", verifier: "none" },
      { key: "scheduled", label: "Scheduled for the intended date and time", verifier: "none" },
    ],
  },
  {
    key: "it_ticket_close",
    label: "IT ticket close",
    stages: ["qa"],
    needsUrl: false,
    items: [
      { key: "root_cause", label: "Root cause recorded, not just the symptom", verifier: "none" },
      { key: "user_confirmed", label: "User confirmed the fix in their own words", verifier: "none" },
      { key: "steps_logged", label: "Steps taken logged for the next person", verifier: "none" },
      { key: "no_typos", label: "No typos in the closing note", verifier: "spellcheck" },
      { key: "recurrence", label: "Recurrence risk assessed and noted", verifier: "none" },
    ],
  },
  {
    key: "client_document",
    label: "Client-facing document",
    stages: ["qa", "tech_review", "pre_launch"],
    needsUrl: false,
    items: [
      { key: "no_typos", label: "No typos anywhere in the document", verifier: "spellcheck" },
      { key: "links_resolve", label: "Every link resolves", verifier: "links" },
      { key: "copy_matches", label: "Content matches the approved scope", verifier: "copy_diff", partial: true },
      { key: "figures_correct", label: "Every figure, date, and name verified against source", verifier: "none" },
      { key: "brand_terms", label: "Positioning language correct throughout", verifier: "none" },
    ],
  },
];

export function checklistByKey(key: string): ChecklistDef | undefined {
  return CHECKLISTS.find((c) => c.key === key);
}

export function itemByKey(checklist: ChecklistDef, key: string): ChecklistItem | undefined {
  return checklist.items.find((i) => i.key === key);
}

/** Verifiers that can independently confirm (not just contradict) a signature. */
export const AUTHORITATIVE_VERIFIERS: VerifierKind[] = ["links", "meta", "mobile", "spellcheck"];
