// Certification surface: sign a checklist, see what Arcadia verified, and see
// the false-certification rate per person and per pod (§4 M2). Staff can
// always see their own numbers — covert scoring does more damage than the
// metric is worth (§5.7).

import { getAgentByName } from "agents";
import { CHECKLISTS, checklistByKey } from "../certification/checklists";
import { canViewPersonRecord, requireCapability, type UserRecord } from "../lib/rbac";
import { html, redirectTo, styles } from "./dashboard";

interface RecentCertRow {
  id: string;
  checklist: string;
  stage: string;
  signed_by: string;
  signed_at: string;
  target_url: string | null;
  fails: number;
  checks: number;
}

interface PersonRate {
  signedBy: string;
  lead: string | null;
  signatures: number;
  falseCerts: number;
  rate: number;
}

interface PodRate {
  pod: string;
  signatures: number;
  falseCerts: number;
  rate: number;
}

export interface LedgerViewData {
  recent: RecentCertRow[];
  personRates: PersonRate[];
  podRates: PodRate[];
  canSeeAllRates: boolean;
}

const AGENT_INSTANCE = "main";

export async function ledgerViewData(env: Env, user: UserRecord): Promise<LedgerViewData> {
  const recent = (
    await env.DB.prepare(
      `SELECT c.id, c.checklist, c.stage, c.signed_by, c.signed_at, c.target_url,
              (SELECT COUNT(*) FROM certification_checks k WHERE k.certification_id = c.id AND k.verdict = 'fail') AS fails,
              (SELECT COUNT(*) FROM certification_checks k WHERE k.certification_id = c.id) AS checks
         FROM certifications c
        ORDER BY c.signed_at DESC
        LIMIT 12`
    ).all<RecentCertRow>()
  ).results;

  const ledger = await getAgentByName(env.Ledger, AGENT_INSTANCE);
  const allPersonRates = await ledger.ratesByPerson();
  // §5.7 read access: yourself, your lead, Shane. Everyone else's numbers are
  // filtered out server-side, not just hidden in the markup.
  const personRates = allPersonRates
    .filter((r) => canViewPersonRecord(user, r.signedBy, r.lead ?? undefined))
    .map((r) => ({ ...r }));
  const canSeeAllRates = personRates.length === allPersonRates.length && allPersonRates.length > 0;
  const podRates = user.role === "superadmin" || user.role === "founder" || user.role === "lead"
    ? (await ledger.ratesByPod()).map((r) => ({ ...r }))
    : [];

  return { recent, personRates, podRates, canSeeAllRates };
}

export function LedgerSection(props: { user: UserRecord; data: LedgerViewData }) {
  const { user, data } = props;
  return (
    <>
      <h2 id="ledger">Certifications</h2>
      <p>
        <small class="muted">
          You sign the checklist. Arcadia independently verifies what she can. A signature she disproves is a
          false certification — recorded against you and visible to your lead.
        </small>
      </p>

      <h3>Sign a checklist</h3>
      <form method="post" action="/approval/ledger/sign">
        <select name="checklist">
          {CHECKLISTS.map((c) => (
            <option value={c.key}>{c.label}</option>
          ))}
        </select>{" "}
        <input type="text" name="stage" placeholder="stage (qa / tech_review / pre_launch)" required />{" "}
        <input type="text" name="targetUrl" placeholder="https://… (if there's a page)" />{" "}
        <input type="text" name="projectId" placeholder="project id (optional)" />
        <br />
        <textarea name="signedText" rows={3} placeholder="Copy being certified, when there is no URL to crawl" />
        <br />
        <label>
          <input type="checkbox" name="attestAll" value="yes" required /> I certify every item on this
          checklist is true right now.
        </label>{" "}
        <button type="submit">Sign</button>
      </form>
      <p>
        <small class="muted">
          Checklists and their items: {CHECKLISTS.map((c) => `${c.label} (${c.items.length})`).join(" · ")}.{" "}
          <a href="/approval/ledger/checklists">See every item and what Arcadia verifies</a>
        </small>
      </p>

      <h3>Recent signatures</h3>
      {data.recent.length === 0 ? (
        <p>
          <small class="muted">Nothing signed yet.</small>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Checklist</th>
              <th>Stage</th>
              <th>Signed by</th>
              <th>Verification</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map((c) => (
              <tr>
                <td>
                  <a href={`/approval/ledger/cert/${c.id}`}>{c.checklist}</a>
                </td>
                <td>{c.stage}</td>
                <td>{c.signed_by}</td>
                <td>
                  {c.fails > 0 ? (
                    <span class="sev-day7">{c.fails} disproved</span>
                  ) : (
                    <small class="muted">{c.checks} checks clean</small>
                  )}
                </td>
                <td>
                  <small class="muted">{c.signed_at}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>False-certification rate{data.canSeeAllRates ? "" : " (yours and your team's)"}</h3>
      {data.personRates.length === 0 ? (
        <p>
          <small class="muted">No signatures recorded for anyone you can see.</small>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Lead</th>
              <th>Signatures</th>
              <th>False certifications</th>
              <th>Rate</th>
            </tr>
          </thead>
          <tbody>
            {data.personRates.map((r) => (
              <tr>
                <td>{r.signedBy}</td>
                <td>
                  <small class="muted">{r.lead ?? "—"}</small>
                </td>
                <td>{r.signatures}</td>
                <td class={r.falseCerts > 0 ? "sev-day5" : undefined}>{r.falseCerts}</td>
                <td>{(r.rate * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.podRates.length > 0 ? (
        <>
          <h3>By pod</h3>
          <table>
            <tbody>
              {data.podRates.map((p) => (
                <tr>
                  <td>{p.pod}</td>
                  <td>{p.signatures} signatures</td>
                  <td class={p.falseCerts > 0 ? "sev-day5" : undefined}>{p.falseCerts} false</td>
                  <td>{(p.rate * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <p>
        <small class="muted">Signed in as {user.email}.</small>
      </p>
    </>
  );
}

function ChecklistsPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Arcadia — checklists</title>
        <style>{styles}</style>
      </head>
      <body>
        <h1>Launch checklists</h1>
        <p>
          <a href="/approval/ops">← back</a>
        </p>
        {CHECKLISTS.map((c) => (
          <>
            <h2>{c.label}</h2>
            <p>
              <small class="muted">
                gates: {c.stages.join(" → ")}
                {c.needsUrl ? " · needs a target URL" : ""}
              </small>
            </p>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Arcadia verifies</th>
                </tr>
              </thead>
              <tbody>
                {c.items.map((i) => (
                  <tr>
                    <td>{i.label}</td>
                    <td>
                      {i.verifier === "none" ? (
                        <small class="muted">no — human only</small>
                      ) : (
                        <>
                          <code>{i.verifier}</code> {i.partial ? <small class="muted">(partial)</small> : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ))}
      </body>
    </html>
  );
}

interface CheckRow {
  item: string;
  verdict: string;
  evidence: string | null;
  checked_at: string;
}

async function certificationPage(env: Env, certId: string): Promise<Response> {
  const cert = await env.DB.prepare(`SELECT * FROM certifications WHERE id = ?1`)
    .bind(certId)
    .first<{
      id: string;
      checklist: string;
      stage: string;
      signed_by: string;
      signed_at: string;
      target_url: string | null;
      items: string;
    }>();
  if (!cert) return new Response("certification not found", { status: 404 });
  const checks = (
    await env.DB.prepare(
      `SELECT item, verdict, evidence, checked_at FROM certification_checks WHERE certification_id = ?1`
    )
      .bind(certId)
      .all<CheckRow>()
  ).results;
  const def = checklistByKey(cert.checklist);
  const signedItems = JSON.parse(cert.items) as Array<{ item: string; label: string }>;

  return html(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Arcadia — certification</title>
        <style>{styles}</style>
      </head>
      <body>
        <h1>{def?.label ?? cert.checklist}</h1>
        <p>
          <a href="/approval/ops">← back</a>
        </p>
        <p>
          Signed by <strong>{cert.signed_by}</strong> at {cert.signed_at} · stage <code>{cert.stage}</code>
          {cert.target_url ? (
            <>
              {" "}
              ·{" "}
              <a href={cert.target_url} target="_blank" rel="noreferrer">
                target
              </a>
            </>
          ) : null}
        </p>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Signed</th>
              <th>Arcadia</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {signedItems.map((si) => {
              const check = checks.find((k) => k.item === si.item);
              return (
                <tr>
                  <td>{si.label}</td>
                  <td>✓</td>
                  <td class={check?.verdict === "fail" ? "sev-day7" : undefined}>{check?.verdict ?? "—"}</td>
                  <td>
                    <small class="muted">{check?.evidence ?? ""}</small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </body>
    </html>
  );
}

/** Owns /approval/ledger*. Returns undefined for anything else. */
export async function handleLedgerRoutes(
  request: Request,
  env: Env,
  user: UserRecord,
  form: FormData | undefined
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/approval/ledger")) return undefined;

  if (request.method === "GET") {
    if (path === "/approval/ledger/checklists") return html(<ChecklistsPage />);
    const certMatch = /^\/approval\/ledger\/cert\/([A-Za-z0-9-]+)$/.exec(path);
    if (certMatch) return certificationPage(env, certMatch[1] as string);
    return undefined;
  }

  if (path === "/approval/ledger/sign" && form) {
    requireCapability(user, "sign_certification");
    const checklist = String(form.get("checklist") ?? "");
    const def = checklistByKey(checklist);
    if (!def) return new Response("unknown checklist", { status: 400 });
    if (form.get("attestAll") !== "yes") {
      return new Response("you must certify every item to sign", { status: 400 });
    }
    const stage = String(form.get("stage") ?? "").trim();
    if (!def.stages.includes(stage)) {
      return new Response(`stage must be one of: ${def.stages.join(", ")}`, { status: 400 });
    }
    const targetUrl = String(form.get("targetUrl") ?? "").trim();
    if (def.needsUrl && !targetUrl) {
      return new Response(`${def.label} needs a target URL — Arcadia cannot verify anything without it`, {
        status: 400,
      });
    }
    const signedText = String(form.get("signedText") ?? "").trim();
    const projectId = String(form.get("projectId") ?? "").trim();

    const ledger = await getAgentByName(env.Ledger, AGENT_INSTANCE);
    const result = await ledger.sign({
      checklist: def.key,
      stage,
      ...(projectId ? { projectId } : {}),
      ...(targetUrl ? { targetUrl } : {}),
      ...(signedText ? { signedText } : {}),
      signedItems: def.items.map((i) => i.key),
      signedBy: user.email,
    });
    return redirectTo(`/ledger/cert/${result.certificationId}`);
  }

  return undefined;
}
