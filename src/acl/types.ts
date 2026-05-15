// Shared ACL types.

export type PrincipalType = "user" | "group" | "tenant";

export type ResourceType =
  | "channel"
  | "chat"
  | "thread"
  | "memory"
  | "task"
  | "digest"
  | "brief"
  | "document"
  | "customer"
  | "project";

export interface Principal {
  type: PrincipalType;
  id: string;
}

export interface Grant {
  resourceType: ResourceType | string;
  resourceId: string;
  principal: Principal;
  grantedAt: string;
}

export interface AccessContext {
  /** AAD id of the user asking. */
  viewerAadId: string;
  /** Tenant the viewer belongs to. */
  tenantId?: string;
}

export type SensitivityPolicy =
  | "public"
  | "restricted"
  | "confidential"
  | "redact";
