// Public surface of src/clients/.
//
//   ClientStore           CRUD on the `clients` table
//   ClientAssetStore      CRUD on `client_assets` + reverse lookup
//   ClientMembership      "can viewer see Client X?" / list-for-viewer
//   ClientScopeResolver   client_id → federated ClientScope
//   ActiveClient          per-user active client pointer + entitlement
//
// Consumers (webapp, chat-stream, intelligence) should depend on this
// barrel rather than the individual files.

export { ClientStore } from "./store";
export { ClientAssetStore } from "./assets";
export { ClientMembership } from "./membership";
export { ClientScopeResolver, buildScope, isEmptyTeamsScope } from "./scope";
export { ActiveClient } from "./active";
export {
  ASSET_KINDS,
  isAssetKind,
  type AssetKind,
  type Client,
  type ClientAsset,
  type ClientScope,
  type ClientStatus,
  type NewClient,
  type NewClientAsset,
} from "./types";
