// Directory read. One session lists active-member profile fields and can
// make the single manager proof call. It does not PATCH a user and it does
// not write a manager. Credentials stay in src/integrations/graph.ts.

import { graphAvailable, graphGet, GraphError } from "../integrations/graph";
import type { DirectoryUserInput } from "../lib/directory-merge";
import { D1GatekeeperQueue } from "./log";
import { GatekeeperDeniedError, type ArcadiaActionQueue, type GatekeeperContext } from "./types";

export interface DirectoryPorts {
  queue: ArcadiaActionQueue;
  available(): boolean;
  get<T>(path: string): Promise<T>;
}

export interface ManagerCallResult {
  called: true;
  ok: true;
  managerId?: string;
  managerMail?: string;
  displayName?: string;
}

export interface ManagerCallFailure {
  called: true;
  ok: false;
  status?: number;
  message: string;
}

export interface DirectorySession {
  available(): boolean;
  /** Every user the tenant returns. The caller filters to active members. */
  listUsers(): Promise<DirectoryUserInput[]>;
  /**
   * One GET /users/{id}/manager. Application permissions are documented as
   * not supported (v1.0, 27 September 2026). The result is logged by the
   * caller. This method does not treat a failure as a manager.
   */
  proveManager(aadId: string): Promise<ManagerCallResult | ManagerCallFailure>;
}

const USER_SELECT = [
  "id",
  "displayName",
  "mail",
  "userPrincipalName",
  "jobTitle",
  "department",
  "officeLocation",
  "mobilePhone",
  "businessPhones",
  "city",
  "state",
  "country",
  "accountEnabled",
  "userType",
].join(",");

const MAX_PAGES = 10;
const GRAPH_ROOT_PREFIX = /^https:\/\/graph\.microsoft\.com\/v1\.0/;

export function directorySessionFromPorts(ports: DirectoryPorts): DirectorySession {
  return {
    available: () => ports.available(),

    async listUsers() {
      if (!ports.available()) {
        throw new GatekeeperDeniedError("Graph credentials are not configured (CLAUDE.md §9)", "graph");
      }
      const users: DirectoryUserInput[] = [];
      let path: string | undefined = `/users?$select=${USER_SELECT}&$top=999`;
      for (let page = 0; path && page < MAX_PAGES; page++) {
        const res: { value: DirectoryUserInput[]; "@odata.nextLink"?: string } = await ports.get(path);
        users.push(...res.value);
        path = res["@odata.nextLink"]?.replace(GRAPH_ROOT_PREFIX, "");
      }
      await ports.queue.authorizeObservation({
        title: "Read directory users",
        description: `${users.length} user object(s) — profile fields only, no street address, no manager`,
      });
      return users;
    },

    async proveManager(aadId) {
      if (!ports.available()) {
        throw new GatekeeperDeniedError("Graph credentials are not configured (CLAUDE.md §9)", "graph");
      }
      try {
        const manager = await ports.get<{ id?: string; mail?: string; userPrincipalName?: string; displayName?: string }>(
          `/users/${encodeURIComponent(aadId)}/manager?$select=id,displayName,mail,userPrincipalName`
        );
        await ports.queue.authorizeObservation({
          title: "Manager proof call",
          description: manager.id
            ? `GET /users/${aadId}/manager returned a manager id. One probe, not a directory of managers.`
            : `GET /users/${aadId}/manager returned no manager id.`,
        });
        return {
          called: true as const,
          ok: true as const,
          ...(manager.id ? { managerId: manager.id } : {}),
          ...(manager.mail || manager.userPrincipalName
            ? { managerMail: manager.mail || manager.userPrincipalName }
            : {}),
          ...(manager.displayName ? { displayName: manager.displayName } : {}),
        };
      } catch (err) {
        const status = err instanceof GraphError ? err.status : undefined;
        const message = err instanceof Error ? err.message : String(err);
        await ports.queue.authorizeObservation({
          title: "Manager proof call failed",
          description: `GET /users/${aadId}/manager did not return a manager. ${message}`.slice(0, 500),
        });
        return {
          called: true as const,
          ok: false as const,
          ...(status !== undefined ? { status } : {}),
          message,
        };
      }
    },
  };
}

export function openDirectorySession(env: Env, ctx: GatekeeperContext): DirectorySession {
  return directorySessionFromPorts({
    queue: new D1GatekeeperQueue(env.DB, "graph", "graph:directory", ctx),
    available: () => graphAvailable(env),
    get: (path) => graphGet(env, path),
  });
}
