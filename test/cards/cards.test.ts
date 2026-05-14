import { describe, expect, it } from "vitest";
import { digestCard } from "../../src/cards/digest";
import { nudgeCard } from "../../src/cards/nudge";
import {
  acknowledgementCard,
  taskCard,
  taskReassignPickerCard,
} from "../../src/cards/task";
import { wrap } from "../../src/cards/types";

describe("digestCard", () => {
  it("emits an Action.Execute refresh keyed to viewer ids", () => {
    const card = digestCard({
      digestId: "d1",
      channelDisplayName: "GNC",
      generatedAt: "2025-01-01T08:00:00Z",
      viewerAadIds: ["aad-1", "aad-2"],
      sections: [
        { title: "Conversation", items: [{ text: "X happened" }] },
        { title: "Open tasks", items: [] },
      ],
    });
    expect(card.refresh?.action.type).toBe("Action.Execute");
    expect(card.refresh?.action.verb).toBe("digest_refresh");
    expect(card.refresh?.userIds).toEqual(["aad-1", "aad-2"]);
    const actions = card.actions ?? [];
    expect(actions.some((a) => a.verb === "digest_dismiss")).toBe(true);
  });

  it("renders an empty-section placeholder", () => {
    const card = digestCard({
      digestId: "d2",
      channelDisplayName: "GNC",
      generatedAt: "2025-01-01T08:00:00Z",
      viewerAadIds: ["aad-1"],
      sections: [{ title: "Stale threads", items: [] }],
    });
    const serialised = JSON.stringify(card);
    expect(serialised).toContain("—");
  });
});

describe("taskCard", () => {
  it("hides actions when status is terminal", () => {
    const done = taskCard({
      taskId: "t1",
      title: "Ship Tuesday",
      priority: "high",
      status: "done",
      viewerAadIds: ["aad-1"],
    });
    expect(done.actions ?? []).toEqual([]);
  });

  it("offers accept/reassign/snooze/complete when open", () => {
    const open = taskCard({
      taskId: "t1",
      title: "Ship Tuesday",
      priority: "high",
      status: "open",
      viewerAadIds: ["aad-1"],
    });
    const verbs = (open.actions ?? []).map((a) => a.verb);
    expect(verbs).toEqual(
      expect.arrayContaining([
        "task_accept",
        "task_reassign",
        "task_snooze",
        "task_complete",
      ]),
    );
  });
});

describe("taskReassignPickerCard", () => {
  it("falls back to Input.Text when no candidates", () => {
    const card = taskReassignPickerCard({
      taskId: "t1",
      title: "Move owner",
      candidates: [],
      viewerAadIds: ["aad-1"],
    });
    const serialised = JSON.stringify(card);
    expect(serialised).toContain("Input.Text");
    expect(serialised).not.toContain("Input.ChoiceSet");
  });

  it("renders a ChoiceSet when candidates are supplied", () => {
    const card = taskReassignPickerCard({
      taskId: "t1",
      title: "Move owner",
      candidates: [
        { aadId: "aad-1", displayName: "Anna" },
        { aadId: "aad-2", displayName: "Bob" },
      ],
      viewerAadIds: ["viewer"],
    });
    const serialised = JSON.stringify(card);
    expect(serialised).toContain("Input.ChoiceSet");
    expect(serialised).toContain("Anna");
    expect(serialised).toContain("aad-2");
  });
});

describe("nudgeCard", () => {
  it("scopes refresh to the targeted user only", () => {
    const card = nudgeCard({
      nudgeId: "n1",
      targetAadId: "aad-1",
      subject: "Ship Tuesday",
      reason: "Deadline in 4h",
      taskId: "t1",
    });
    expect(card.refresh?.userIds).toEqual(["aad-1"]);
    const verbs = (card.actions ?? []).map((a) => a.verb);
    expect(verbs).toContain("nudge_acknowledge");
    expect(verbs).toContain("nudge_snooze");
  });
});

describe("acknowledgementCard", () => {
  it("renders a short two-block body with no actions", () => {
    const card = acknowledgementCard({
      title: "Snoozed",
      body: "I'll come back later.",
    });
    expect(card.actions).toBeUndefined();
    expect(JSON.stringify(card)).toContain("Snoozed");
  });
});

describe("wrap", () => {
  it("wraps with the adaptive contentType", () => {
    const env = wrap({
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.5",
      body: [],
    });
    expect(env.contentType).toBe("application/vnd.microsoft.card.adaptive");
  });
});
