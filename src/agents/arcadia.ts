// Arcadia — the scheduler Durable Object. It runs the daily roster sync and
// the shift-pattern post, and takes on-demand directory syncs so a page does
// not wait on Microsoft 365.

import { Agent } from "agents";
import { syncDirectory } from "../directory/sync";
import { postShiftPatterns } from "../schedule/post-patterns";

export class Arcadia extends Agent<Env> {
  ping(): string {
    return "ok";
  }

  async onStart() {
    // Schedules stored by an earlier build can name a method that no longer
    // exists. The SDK would log "callback not found" for them on every run,
    // so cancel them before setting the current ones.
    for (const s of await this.listSchedules()) {
      if (typeof (this as unknown as Record<string, unknown>)[s.callback] !== "function") {
        await this.cancelSchedule(s.id);
      }
    }
    // Cron schedules are idempotent in the agents SDK, so waking the DO again
    // does not stack a second copy. Each job no-ops when the consent or the
    // config it needs is absent.
    await this.schedule("15 6 * * *", "syncDirectory");
    await this.schedule("30 6 * * *", "postShiftPatterns");
  }

  async syncDirectory(): Promise<void> {
    await syncDirectory(this.env, "arcadia");
  }

  /**
   * Queue a sync and return. The alarm fires about a second later, so the
   * page that asked for it does not wait on Microsoft 365.
   */
  async kickRepositorySync(_job: "directory"): Promise<void> {
    await this.schedule(1, "syncDirectory", undefined, { idempotent: true });
  }

  async postShiftPatterns(): Promise<void> {
    await postShiftPatterns(this.env, "arcadia");
  }
}
