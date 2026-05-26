import { describe, expect, it } from "vitest";
import { buildScope, isEmptyTeamsScope } from "../../src/clients/scope";
import { isAssetKind, type ClientAsset } from "../../src/clients/types";

function asset(
  kind: ClientAsset["assetKind"],
  id: string,
): ClientAsset {
  return {
    clientId: "c1",
    assetKind: kind,
    assetId: id,
    addedBy: "admin",
    addedAt: "2026-05-26T00:00:00Z",
  };
}

describe("buildScope", () => {
  it("partitions assets by kind into the right buckets", () => {
    const scope = buildScope("c1", [
      asset("teams_team", "team-A"),
      asset("teams_channel", "chan-1"),
      asset("teams_channel", "chan-2"),
      asset("teams_chat", "chat-1"),
      asset("planner_plan", "plan-1"),
      asset("sharepoint_site", "site-1"),
      asset("loop_workspace", "loop-1"),
      asset("enque_team", "enq-1"),
    ]);

    expect(scope.clientId).toBe("c1");
    expect(scope.teamIds).toEqual(["team-A"]);
    expect(scope.channelIds).toEqual(["chan-1", "chan-2"]);
    expect(scope.chatIds).toEqual(["chat-1"]);
    expect(scope.plannerPlanIds).toEqual(["plan-1"]);
    expect(scope.sharepointSiteIds).toEqual(["site-1"]);
    expect(scope.loopWorkspaceIds).toEqual(["loop-1"]);
    expect(scope.enqueTeamIds).toEqual(["enq-1"]);
  });

  it("returns an empty scope when there are no assets", () => {
    const scope = buildScope("c-empty", []);
    expect(scope.channelIds).toEqual([]);
    expect(scope.chatIds).toEqual([]);
    expect(scope.teamIds).toEqual([]);
    expect(scope.plannerPlanIds).toEqual([]);
    expect(scope.sharepointSiteIds).toEqual([]);
    expect(scope.loopWorkspaceIds).toEqual([]);
    expect(scope.enqueTeamIds).toEqual([]);
  });
});

describe("isEmptyTeamsScope", () => {
  it("is true when channels + chats are both empty", () => {
    expect(
      isEmptyTeamsScope(buildScope("c1", [asset("planner_plan", "p1")])),
    ).toBe(true);
  });

  it("is false when a channel is present", () => {
    expect(
      isEmptyTeamsScope(buildScope("c1", [asset("teams_channel", "ch")])),
    ).toBe(false);
  });

  it("is false when only a chat is present", () => {
    expect(
      isEmptyTeamsScope(buildScope("c1", [asset("teams_chat", "ch")])),
    ).toBe(false);
  });
});

describe("isAssetKind", () => {
  it("accepts every defined asset kind", () => {
    for (const k of [
      "teams_team",
      "teams_channel",
      "teams_chat",
      "planner_plan",
      "sharepoint_site",
      "loop_workspace",
      "enque_team",
    ]) {
      expect(isAssetKind(k)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isAssetKind("teams_loop")).toBe(false);
    expect(isAssetKind("")).toBe(false);
    expect(isAssetKind("Teams_Channel")).toBe(false);
  });
});
