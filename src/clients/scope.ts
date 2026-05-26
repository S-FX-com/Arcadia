// Client scope resolver.
//
// Turns a client_id into the federated ClientScope — the union of
// channel/chat/team/plan/site ids the active Client covers. This is
// what intelligence/digest, decisions, briefs, and chat read so a
// single Arcadia answer reaches across every asset in the bundle.
//
// Asset kinds that don't yet have a fetcher (e.g. `enque_team` until
// the custom Enque repo is wired) are kept in the schema and accepted
// by admin APIs, but contribute an empty list to the scope here.

import type { Env } from "../env";
import { ClientAssetStore } from "./assets";
import type { ClientAsset, ClientScope } from "./types";

export class ClientScopeResolver {
  private readonly assets: ClientAssetStore;
  constructor(private readonly env: Env) {
    this.assets = new ClientAssetStore(env);
  }

  async resolve(clientId: string): Promise<ClientScope> {
    const rows = await this.assets.listForClient(clientId);
    return buildScope(clientId, rows);
  }
}

export function buildScope(
  clientId: string,
  assets: ClientAsset[],
): ClientScope {
  const scope: ClientScope = {
    clientId,
    channelIds: [],
    chatIds: [],
    teamIds: [],
    plannerPlanIds: [],
    sharepointSiteIds: [],
    loopWorkspaceIds: [],
    enqueTeamIds: [],
  };
  for (const a of assets) {
    switch (a.assetKind) {
      case "teams_channel":
        scope.channelIds.push(a.assetId);
        break;
      case "teams_chat":
        scope.chatIds.push(a.assetId);
        break;
      case "teams_team":
        scope.teamIds.push(a.assetId);
        break;
      case "planner_plan":
        scope.plannerPlanIds.push(a.assetId);
        break;
      case "sharepoint_site":
        scope.sharepointSiteIds.push(a.assetId);
        break;
      case "loop_workspace":
        scope.loopWorkspaceIds.push(a.assetId);
        break;
      case "enque_team":
        scope.enqueTeamIds.push(a.assetId);
        break;
    }
  }
  return scope;
}

/** True when the scope reaches no Teams content (channels + chats both empty). */
export function isEmptyTeamsScope(scope: ClientScope): boolean {
  return scope.channelIds.length === 0 && scope.chatIds.length === 0;
}
