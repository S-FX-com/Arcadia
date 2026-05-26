// Client + ClientAsset shared types.
//
// A "Client" is a first-class scope: a bundle of M365 + Enque assets
// used to serve one external partner. The asset bundle is what makes
// it federated — when the active Client is "Morgan Stanley", a query
// for "open tasks" reaches into all the Morgan Stanley team channels,
// chats, Planner plans, SharePoint sites, etc. in one shot.

export type ClientStatus = "active" | "archived";

export type AssetKind =
  | "teams_team"
  | "teams_channel"
  | "teams_chat"
  | "planner_plan"
  | "sharepoint_site"
  | "loop_workspace"
  | "enque_team";

export const ASSET_KINDS: readonly AssetKind[] = [
  "teams_team",
  "teams_channel",
  "teams_chat",
  "planner_plan",
  "sharepoint_site",
  "loop_workspace",
  "enque_team",
] as const;

export interface Client {
  id: string;
  displayName: string;
  slug: string;
  description?: string;
  status: ClientStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClientAsset {
  clientId: string;
  assetKind: AssetKind;
  assetId: string;
  label?: string;
  addedBy: string;
  addedAt: string;
}

export interface NewClient {
  displayName: string;
  slug: string;
  description?: string;
  createdBy: string;
}

export interface NewClientAsset {
  assetKind: AssetKind;
  assetId: string;
  label?: string;
  addedBy: string;
}

/**
 * The federated set of resource ids that belong to one Client,
 * grouped by asset kind. Consumers (digest, decisions, briefs, chat)
 * use this to widen queries from one (channel|chat) row to the union
 * of all assets in the Client.
 */
export interface ClientScope {
  clientId: string;
  channelIds: string[];
  chatIds: string[];
  teamIds: string[];
  plannerPlanIds: string[];
  sharepointSiteIds: string[];
  loopWorkspaceIds: string[];
  enqueTeamIds: string[];
}

export function isAssetKind(s: string): s is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(s);
}
