// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Activity utilities
//
// Small helpers used by the Teams bot handler: channel-id extraction from the
// heterogeneous Teams activity payload, and a thin wrapper around the Bot
// Framework token provider.
// ─────────────────────────────────────────────────────────────────────────────

import { BotFrameworkTokenProvider } from "../auth/token-manager.js";
import type { Env, TeamsActivity } from "../types.js";

export function extractChannelIds(activity: TeamsActivity): {
  teamId: string;
  channelId: string;
  channelName: string;
} {
  const teamId =
    activity.channelData?.team?.aadGroupId ??
    activity.channelData?.teamsTeamId ??
    activity.channelData?.team?.id ??
    activity.conversation.tenantId ??
    "unknown";

  const channelId =
    activity.channelData?.teamsChannelId ??
    activity.channelData?.channel?.id ??
    activity.conversation.id;

  const channelName =
    activity.channelData?.channel?.name ??
    activity.conversation.name ??
    "General";

  return { teamId, channelId, channelName };
}

export function getBotToken(env: Env): Promise<string> {
  return new BotFrameworkTokenProvider(env).getToken();
}
