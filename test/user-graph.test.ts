import { describe, expect, it } from "vitest";
import { userGraphSessionFromPorts, type UserGraphPorts } from "../src/gatekeepers/user-graph";
import type { ActionAuthorization, ActionDescription, ObservationDescription } from "../src/gatekeepers/types";

class RecordingQueue {
  observations: ObservationDescription[] = [];
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }
  async submitAction(_key: string, _description: ActionDescription): Promise<void> {}
  async recordDecision(_key: string, _auth: ActionAuthorization): Promise<void> {}
  async recordApplied(_key: string, _result: string): Promise<void> {}
  async recordFailed(_key: string, _err: string): Promise<void> {}
}

describe("user-graph session", () => {
  it("refuses reads when the Specialist has not connected Graph", async () => {
    const queue = new RecordingQueue();
    const ports: UserGraphPorts = {
      queue,
      connected: async () => false,
      get: async () => {
        throw new Error("should not call Graph");
      },
    };
    const session = userGraphSessionFromPorts({ email: "allie@s-fx.com", aadId: "oid-1" }, ports);
    expect(await session.available()).toBe(false);
    await expect(session.myMail()).rejects.toThrow(/not connected/);
    expect(queue.observations).toHaveLength(0);
  });

  it("logs an observation before returning inbox metadata", async () => {
    const queue = new RecordingQueue();
    const ports: UserGraphPorts = {
      queue,
      connected: async () => true,
      get: async <T>() =>
        ({
          value: [
            {
              subject: "Window change",
              from: { emailAddress: { address: "dan@client.com" } },
              receivedDateTime: "2026-08-18T12:00:00Z",
            },
          ],
        }) as T,
    };
    const session = userGraphSessionFromPorts({ email: "allie@s-fx.com", aadId: "oid-1" }, ports);
    const mail = await session.myMail();
    expect(mail).toEqual([{ subject: "Window change", from: "dan@client.com", received: "2026-08-18T12:00:00Z" }]);
    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]?.prohibitAllSharing).toBe(true);
  });
});
