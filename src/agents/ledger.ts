// Ledger — certification ledger sub-agent. Ships in Phase 1b (M2, §4).
// The highest-leverage component in the project.
//
// Work cannot advance a stage until the doer signs a pre-flight checklist —
// timestamped, immutable, attributed (D1 tables already exist in
// src/schema/d1.sql). Arcadia then independently verifies the subset she can:
// spell/grammar on rendered DOM, link crawl, mobile-width render (Browser
// Rendering at 390px), meta fields, copy diff. A signature the verifier
// disproves is a FALSE CERTIFICATION EVENT — logged, attributed, surfaced to
// the signer's lead. False-certification rate must be queryable per person.

import { Agent } from "agents";

export class Ledger extends Agent<Env> {
  ping(): string {
    return "ok";
  }

  override async onRequest(_request: Request): Promise<Response> {
    return Response.json(
      { error: "Certification Ledger ships in Phase 1b — see CLAUDE.md §4 M2" },
      { status: 501 }
    );
  }
}
