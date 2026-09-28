// One panel on Leadership, Directory, and the plan index. Last sync, how
// many rows it left, the last error in plain words, and a button. A missing
// credential is one line.

import type { JSX } from "preact";
import { formatSyncedAt } from "../lib/m365-sync";

export function M365SyncPanel(props: {
  lastSynced: string | null;
  rowCount: number;
  rowLabel: string;
  lastError: string | null;
  missing: string | null;
  action: string;
}): JSX.Element {
  const { lastSynced, rowCount, rowLabel, lastError, missing, action } = props;
  return (
    <section class="sync-panel">
      <h2>Sync from Microsoft 365</h2>
      {missing ? <p class="banner warn">{missing}</p> : null}
      <p>
        <small class="muted">
          Last synced {formatSyncedAt(lastSynced)}. {rowCount} {rowLabel}. Last error: {lastError ?? "None"}.
        </small>
      </p>
      <form method="post" action={action}>
        <button type="submit" class="primary">
          Sync from Microsoft 365
        </button>
      </form>
    </section>
  );
}
