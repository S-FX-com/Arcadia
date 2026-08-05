// Microsoft Graph integration — Phase 1b+ (§3, §8).
//
// Phase 1a has ZERO Microsoft dependency by design: no Azure Bot
// registration, no app registration, no Global Admin consent (§4). Do not
// import this module from any Phase 1a path.
//
// When Phase 1b starts (after §9.7 and open question §10.1 are resolved):
// application-scoped, minimum permissions — Files.Read.All, Sites.Read.All,
// Tasks.ReadWrite.All, ChannelMessage.Read.All, Chat.Read.All, User.Read.All,
// Presence.Read.All, Calendars.Read.

export interface GraphEnv {
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CLIENT_SECRET?: string;
}

export function graphClient(_env: GraphEnv): never {
  throw new Error("Microsoft Graph integration is Phase 1b+ — Phase 1a has zero Microsoft dependency (CLAUDE.md §4)");
}
