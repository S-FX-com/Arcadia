// Domain types shared across Arcadia modules. D1 row shapes live next to the
// queries that read them; these are the cross-module contracts.

export interface AuditEntry {
  actor: string;
  action: string;
  subject?: string | undefined;
  detail?: string | undefined;
}
