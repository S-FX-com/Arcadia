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

export interface ManagerRead {
  aadId: string;
  managerId: string | null;
  managerMail: string | null;
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
  /**
   * Further manager reads, only after the proof succeeded. A 404 is an
   * empty line. 401 and 403 stop the rest of the batch. No Entra write.
   */
  readManagers(aadIds: string[], maxReads: number): Promise<{ rows: ManagerRead[]; stopped: boolean }>;
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

    async readManagers(aadIds, maxReads) {
      if (!ports.available()) {
        throw new GatekeeperDeniedError("Graph credentials are not configured (CLAUDE.md §9)", "graph");
      }
      const rows: ManagerRead[] = [];
      const limit = Math.max(0, maxReads);
      let stopped = false;
      for (const aadId of aadIds.slice(0, limit)) {
        try {
          const manager = await ports.get<{ id?: string; mail?: string; userPrincipalName?: string }>(
            `/users/${encodeURIComponent(aadId)}/manager?$select=id,mail,userPrincipalName`
          );
          rows.push({
            aadId,
            managerId: manager.id?.trim() || null,
            managerMail: (manager.mail || manager.userPrincipalName)?.trim() || null,
          });
        } catch (err) {
          const status = err instanceof GraphError ? err.status : undefined;
          if (status === 401 || status === 403) {
            stopped = true;
            await ports.queue.authorizeObservation({
              title: "Manager read stopped",
              description: `GET /users/${aadId}/manager was refused. Remaining manager reads were not attempted.`,
            });
            break;
          }
          rows.push({ aadId, managerId: null, managerMail: null });
        }
      }
      if (rows.length > 0) {
        await ports.queue.authorizeObservation({
          title: "Read directory managers",
          description: `${rows.length} manager read(s) after a successful proof. No Entra write.`,
        });
      }
      return { rows, stopped };
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
