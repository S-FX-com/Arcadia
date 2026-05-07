// Shared shapes between the client and the Arcadia Worker. Mirrors of
// types declared in src/agent/tools/types.ts on the worker side; kept
// thin so the client doesn't need a build-time worker import.

export interface ToolCitation {
	resourceType: string;
	resourceId: string;
	label?: string;
	url?: string;
}

export type ChatMessageRole = "user" | "assistant";

export interface ChatTurn {
	role: ChatMessageRole;
	content: string;
	citations?: ToolCitation[];
	pending?: boolean;
}
