// Admin surface: model routing and staff/roles. Both require explicit
// capabilities (admin_models / admin_users) — superadmin only by default, and
// checked server-side on every mutation, not just hidden in the UI.

import { loadRouting, resetRouting, setRouting } from "../ai/router";
import {
  MODEL_CATALOG,
  TASK_KINDS,
  TASK_TIERS,
  type ModelBinding,
  type Provider,
  type TaskKind,
} from "../ai/types";
import { appendAudit } from "../lib/audit";
import {
  ALL_ROLES,
  can,
  listUsers,
  requireCapability,
  setUserActive,
  upsertUser,
  type Role,
  type UserRecord,
} from "../lib/rbac";

function isProvider(v: string): v is Provider {
  return v === "workers-ai" || v === "anthropic";
}
function isTaskKind(v: string): v is TaskKind {
  return (TASK_KINDS as string[]).includes(v);
}
function isRole(v: string): v is Role {
  return (ALL_ROLES as string[]).includes(v);
}

export function AdminSection(props: {
  user: UserRecord;
  routing: Record<TaskKind, ModelBinding>;
  overriddenTasks: string[];
  staff: UserRecord[];
}) {
  const { user, routing, overriddenTasks, staff } = props;
  const showModels = can(user, "admin_models");
  const showUsers = can(user, "admin_users");
  if (!showModels && !showUsers) return null;

  return (
    <>
      {showModels ? (
        <>
          <h2>Model routing</h2>
          <p>
            <small class="muted">
              Defaults are Cloudflare Workers AI. Point any task at Claude (via AI Gateway) when the quality
              is worth the cost — routing is per task and takes effect within a minute. Deep-tier models
              require a Workers Paid plan.
            </small>
          </p>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Tier</th>
                <th>Model</th>
                <th>Max tokens</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {TASK_KINDS.map((task) => {
                const binding = routing[task];
                const overridden = overriddenTasks.includes(task);
                return (
                  <tr>
                    <td>
                      <code>{task}</code>
                      {overridden ? <strong> *</strong> : null}
                    </td>
                    <td>
                      <small class="muted">{TASK_TIERS[task]}</small>
                    </td>
                    <td colSpan={3}>
                      <form class="inline" method="post" action="/approval/admin/models">
                        <input type="hidden" name="task" value={task} />
                        <select name="binding">
                          {MODEL_CATALOG.map((m) => (
                            <option
                              value={`${m.provider}|${m.model}`}
                              selected={m.provider === binding.provider && m.model === binding.model}
                            >
                              {m.label} — {m.note}
                            </option>
                          ))}
                        </select>{" "}
                        <input
                          type="number"
                          name="maxTokens"
                          value={String(binding.maxTokens)}
                          min="128"
                          max="128000"
                          style="width:6.5rem"
                        />{" "}
                        <button type="submit">Save</button>{" "}
                        {overridden ? (
                          <button name="action" value="reset" type="submit">
                            Reset
                          </button>
                        ) : null}
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            <small class="muted">* overridden from the built-in default</small>
          </p>
        </>
      ) : null}

      {showUsers ? (
        <>
          <h2>Staff and roles</h2>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Lead</th>
                <th>Pod</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr>
                  <td>
                    {s.email}
                    {s.grants.length ? (
                      <>
                        {" "}
                        <small class="muted">+{s.grants.join(", ")}</small>
                      </>
                    ) : null}
                  </td>
                  <td>{s.role}</td>
                  <td>
                    <small class="muted">{s.leadEmail ?? "—"}</small>
                  </td>
                  <td>
                    <small class="muted">{s.pod ?? "—"}</small>
                  </td>
                  <td>
                    <form class="inline" method="post" action="/approval/admin/users">
                      <input type="hidden" name="email" value={s.email} />
                      <input type="hidden" name="action" value={s.active ? "deactivate" : "activate"} />
                      <button type="submit">{s.active ? "yes — deactivate" : "no — activate"}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 style="font-size:.95rem">Add or update a person</h3>
          <form method="post" action="/approval/admin/users">
            <input type="hidden" name="action" value="upsert" />
            <input type="text" name="email" placeholder="name@s-fx.com" required />{" "}
            <input type="text" name="displayName" placeholder="Display name" />{" "}
            <select name="role">
              {ALL_ROLES.map((r) => (
                <option value={r} selected={r === "specialist"}>
                  {r}
                </option>
              ))}
            </select>{" "}
            <input type="text" name="leadEmail" placeholder="lead@s-fx.com" />{" "}
            <input type="text" name="pod" placeholder="pod" />{" "}
            <button type="submit">Save person</button>
          </form>
        </>
      ) : null}
    </>
  );
}

export async function handleAdminModels(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "admin_models");
  const task = String(form.get("task") ?? "");
  if (!isTaskKind(task)) return new Response("unknown task", { status: 400 });

  if (String(form.get("action")) === "reset") {
    await resetRouting(env, task);
    await appendAudit(env.DB, {
      actor: user.email,
      action: "model_routing_reset",
      subject: task,
    });
    return new Response(null, { status: 303, headers: { Location: "/approval/admin#models" } });
  }

  const [provider, ...modelParts] = String(form.get("binding") ?? "").split("|");
  const model = modelParts.join("|");
  if (!provider || !isProvider(provider) || !model) {
    return new Response("invalid model selection", { status: 400 });
  }
  const maxTokens = Number.parseInt(String(form.get("maxTokens") ?? ""), 10);
  if (!Number.isFinite(maxTokens) || maxTokens < 128 || maxTokens > 128_000) {
    return new Response("maxTokens must be between 128 and 128000", { status: 400 });
  }
  // A task routed to Anthropic without a key would fail at call time — refuse
  // the config change instead, so the failure surfaces here and not mid-run.
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) {
    return new Response(
      "ANTHROPIC_API_KEY is not configured. Add the secret before routing a task to Claude.",
      { status: 400 }
    );
  }

  await setRouting(env, task, { provider, model, maxTokens }, user.email);
  await appendAudit(env.DB, {
    actor: user.email,
    action: "model_routing_changed",
    subject: task,
    detail: `${provider} ${model} (max ${maxTokens})`,
  });
  return new Response(null, { status: 303, headers: { Location: "/approval/admin#models" } });
}

export async function handleAdminUsers(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "admin_users");
  const action = String(form.get("action") ?? "");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return new Response("valid email required", { status: 400 });

  if (action === "upsert") {
    const role = String(form.get("role") ?? "specialist");
    if (!isRole(role)) return new Response("unknown role", { status: 400 });
    const displayName = String(form.get("displayName") ?? "").trim();
    const leadEmail = String(form.get("leadEmail") ?? "").trim().toLowerCase();
    const pod = String(form.get("pod") ?? "").trim();
    await upsertUser(env, {
      email,
      ...(displayName ? { displayName } : {}),
      role,
      ...(leadEmail ? { leadEmail } : {}),
      ...(pod ? { pod } : {}),
    });
    await appendAudit(env.DB, {
      actor: user.email,
      action: "user_upserted",
      subject: email,
      detail: `role=${role}${leadEmail ? ` lead=${leadEmail}` : ""}${pod ? ` pod=${pod}` : ""}`,
    });
    return new Response(null, { status: 303, headers: { Location: "/approval/admin#staff" } });
  }

  if (action === "activate" || action === "deactivate") {
    // Superadmins are the only ones who can administer users; locking the
    // last one out would leave the tenancy unadministrable.
    if (action === "deactivate") {
      const staff = await listUsers(env);
      const activeSuperadmins = staff.filter((s) => s.role === "superadmin" && s.active);
      if (activeSuperadmins.length <= 1 && activeSuperadmins.some((s) => s.email.toLowerCase() === email)) {
        return new Response("refusing to deactivate the last active superadmin", { status: 400 });
      }
    }
    await setUserActive(env, email, action === "activate");
    await appendAudit(env.DB, {
      actor: user.email,
      action: `user_${action}d`,
      subject: email,
    });
    return new Response(null, { status: 303, headers: { Location: "/approval/admin#staff" } });
  }

  return new Response("unknown action", { status: 400 });
}

export async function adminViewData(env: Env, user: UserRecord) {
  const routing = await loadRouting(env);
  const overridden = can(user, "admin_models")
    ? await env.DB.prepare(`SELECT task FROM model_config`)
        .all<{ task: string }>()
        .then((r) => r.results.map((x) => x.task))
        .catch(() => [])
    : [];
  const staff = can(user, "admin_users") ? await listUsers(env) : [];
  return { routing, overriddenTasks: overridden, staff };
}
