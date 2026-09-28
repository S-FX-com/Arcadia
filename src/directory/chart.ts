// Leadership's chart, read from D1. Graph is not called here.

import { latestDirectoryProof } from "./sync";
import { mergeOverlay } from "../lib/directory-merge";
import {
  buildDirectoryTree,
  initials,
  resolveChartEdge,
  type ChartEdge,
  type ChartPerson,
  type DirectoryTree,
} from "../lib/directory-chart";

export interface DirectoryChartData {
  tree: DirectoryTree;
  people: ChartPerson[];
  edges: Map<string, ChartEdge>;
  /** `${source}:${managerId}` so a title-only save does not freeze the line. */
  baselines: Map<string, string>;
  /** Arcadia title only. Blank on the form leaves the Graph title in place. */
  titleOverrides: Map<string, string | null>;
  graphTitles: Map<string, string | null>;
}

interface ChartRow {
  aad_id: string;
  mail: string | null;
  display_name: string | null;
  job_title: string | null;
  department: string | null;
  title_override: string | null;
  department_override: string | null;
  overlay_present: string | null;
  overlay_manager_aad_id: string | null;
  graph_manager_aad_id: string | null;
}

export async function loadDirectoryChart(env: Env): Promise<DirectoryChartData> {
  const rows = (
    await env.DB.prepare(
      `SELECT p.aad_id, p.mail, p.display_name, p.job_title, p.department,
              o.title_override, o.department_override,
              m.aad_id AS overlay_present, m.manager_aad_id AS overlay_manager_aad_id,
              g.manager_aad_id AS graph_manager_aad_id
         FROM directory_profiles p
         LEFT JOIN directory_overlay o ON o.aad_id = p.aad_id
         LEFT JOIN directory_manager_overlay m ON m.aad_id = p.aad_id
         LEFT JOIN directory_graph_managers g ON g.aad_id = p.aad_id
        WHERE p.account_enabled = 1
        ORDER BY p.display_name, p.mail`
    ).all<ChartRow>()
  ).results;
  const leads = (
    await env.DB.prepare(`SELECT email, lead_email FROM users WHERE lead_email IS NOT NULL`).all<{
      email: string;
      lead_email: string;
    }>()
  ).results;
  const proof = await latestDirectoryProof(env);
  const proofSucceeded = proof?.status === "succeeded";

  const people: ChartPerson[] = rows.map((row) => {
    const merged = mergeOverlay(
      { jobTitle: row.job_title, department: row.department },
      { titleOverride: row.title_override, departmentOverride: row.department_override }
    );
    const name = row.display_name?.trim() || row.mail || row.aad_id;
    return {
      id: row.aad_id,
      email: row.mail?.toLowerCase() ?? null,
      name,
      title: merged.title.shown,
      department: merged.department.shown,
      initials: initials(name),
    };
  });
  const idByEmail = new Map(people.flatMap((person) => (person.email ? [[person.email, person.id] as const] : [])));
  const graphById = new Map<string, string>();
  if (proofSucceeded) {
    for (const row of rows) {
      if (row.graph_manager_aad_id) graphById.set(row.aad_id, row.graph_manager_aad_id);
    }
    if (proof?.probedAadId && proof.managerId && !graphById.has(proof.probedAadId)) {
      graphById.set(proof.probedAadId, proof.managerId);
    }
  }
  const leadByEmail = new Map(leads.map((row) => [row.email.toLowerCase(), row.lead_email.toLowerCase()]));

  const edges = new Map<string, ChartEdge>();
  const baselines = new Map<string, string>();
  const titleOverrides = new Map<string, string | null>();
  const graphTitles = new Map<string, string | null>();
  for (const row of rows) {
    titleOverrides.set(row.aad_id, row.title_override?.trim() || null);
    graphTitles.set(row.aad_id, row.job_title?.trim() || null);
    const email = row.mail?.toLowerCase() ?? null;
    const leadEmail = email ? leadByEmail.get(email) : undefined;
    const edge = resolveChartEdge({
      personId: row.aad_id,
      overlay: row.overlay_present ? { managerId: row.overlay_manager_aad_id } : null,
      graphManagerId: graphById.get(row.aad_id) ?? null,
      proofSucceeded,
      leadManagerId: leadEmail ? (idByEmail.get(leadEmail) ?? null) : null,
    });
    edges.set(row.aad_id, edge);
    baselines.set(row.aad_id, `${edge.source}:${edge.managerId ?? ""}`);
  }

  return {
    tree: buildDirectoryTree(people, [...edges.values()]),
    people,
    edges,
    baselines,
    titleOverrides,
    graphTitles,
  };
}
