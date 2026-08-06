// Gatekeeper activity (Cloudflare OS integration). What Arcadia read and did
// through capability sessions, on whose behalf — the observation log and the
// action queue, beside the audit tail they complement. A 'pending' or
// 'failed' action here is the enforcement working: something asked for a
// side effect without the authorization to apply it.

import { blockedActions, recentActions, recentObservations, type ActionRow, type ObservationRow } from "../gatekeepers/log";
import { can, type UserRecord } from "../lib/rbac";

export interface GatekeeperViewData {
  observations: ObservationRow[];
  actions: ActionRow[];
  blocked: ActionRow[];
}

export async function gatekeeperViewData(env: Env, user: UserRecord): Promise<GatekeeperViewData> {
  if (!can(user, "view_audit")) return { observations: [], actions: [], blocked: [] };
  const [observations, actions, blocked] = await Promise.all([
    recentObservations(env.DB, 20),
    recentActions(env.DB, 15),
    blockedActions(env.DB),
  ]);
  return { observations, actions, blocked };
}

export function GatekeeperSection(props: { user: UserRecord; data: GatekeeperViewData }) {
  if (!can(props.user, "view_audit")) return null;
  const { observations, actions, blocked } = props.data;
  return (
    <>
      <h2 id="gatekeepers">Gatekeepers</h2>
      <p>
        <small class="muted">
          Every external read is an observation; every side effect is an action that applies only with
          recorded authorization. Blocked actions are the guardrail firing, not noise.
        </small>
      </p>

      {blocked.length > 0 ? (
        <>
          <h3>Blocked actions ({blocked.length})</h3>
          <table>
            <tbody>
              {blocked.map((a) => (
                <tr>
                  <td>
                    <small class="muted">{a.created_at}</small>
                  </td>
                  <td>
                    <code>{a.gatekeeper}</code>
                  </td>
                  <td>{a.title}</td>
                  <td class="sev-day5">{a.status}</td>
                  <td>
                    <small class="muted">{a.result ?? ""}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <h3>Recent actions</h3>
      {actions.length === 0 ? (
        <p>
          <small class="muted">No gatekeeper actions yet.</small>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Gatekeeper</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Status</th>
              <th>Decided by</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr>
                <td>
                  <small class="muted">{a.created_at}</small>
                </td>
                <td>
                  <code>{a.gatekeeper}</code>
                </td>
                <td>
                  {a.title} <small class="muted">({a.action_kind})</small>
                </td>
                <td>{a.actor}</td>
                <td>{a.status}</td>
                <td>{a.decided_by ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Recent observations</h3>
      {observations.length === 0 ? (
        <p>
          <small class="muted">No observations logged yet.</small>
        </p>
      ) : (
        <table>
          <tbody>
            {observations.map((o) => (
              <tr>
                <td>
                  <small class="muted">{o.created_at}</small>
                </td>
                <td>
                  <code>{o.gatekeeper}</code>
                </td>
                <td>{o.title}</td>
                <td>
                  <small class="muted">
                    {o.actor} · {o.resource}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
