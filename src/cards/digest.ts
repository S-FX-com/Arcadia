// Daily-digest Universal Action card.
//
// Re-renders per viewer via the `refresh` block, so the activity handler
// can ACL-filter sections server-side on each refresh.

import type { AdaptiveCard } from "./types";

export interface DigestSection {
  title: string;
  items: { text: string; subtitle?: string }[];
}

export interface DigestInput {
  digestId: string;
  channelDisplayName: string;
  generatedAt: string;
  viewerAadIds: string[];
  sections: DigestSection[];
  followUpUrl?: string;
}

export function digestCard(input: DigestInput): AdaptiveCard {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    refresh: {
      action: {
        type: "Action.Execute",
        verb: "digest_refresh",
        data: { digestId: input.digestId },
      },
      userIds: input.viewerAadIds,
    },
    msteams: { width: "Full" },
    body: [
      {
        type: "TextBlock",
        text: `${input.channelDisplayName} — digest`,
        weight: "Bolder",
        size: "Medium",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: `Generated ${input.generatedAt}`,
        isSubtle: true,
        spacing: "None",
        wrap: true,
      },
      ...input.sections.flatMap((s) => [
        {
          type: "TextBlock",
          text: s.title,
          weight: "Bolder",
          spacing: "Medium",
          wrap: true,
        },
        ...(s.items.length === 0
          ? [
              {
                type: "TextBlock",
                text: "—",
                isSubtle: true,
                wrap: true,
              },
            ]
          : s.items.map((it) => ({
              type: "Container",
              spacing: "Small",
              items: [
                { type: "TextBlock", text: it.text, wrap: true },
                ...(it.subtitle
                  ? [
                      {
                        type: "TextBlock",
                        text: it.subtitle,
                        isSubtle: true,
                        spacing: "None",
                        wrap: true,
                      },
                    ]
                  : []),
              ],
            }))),
      ]),
    ],
    actions: [
      ...(input.followUpUrl
        ? [
            {
              type: "Action.Execute" as const,
              verb: "feedback" as const,
              title: "Open in app",
              data: { url: input.followUpUrl },
            },
          ]
        : []),
      {
        type: "Action.Execute",
        verb: "digest_dismiss",
        title: "Dismiss",
        data: { digestId: input.digestId },
      },
    ],
  };
}
