// What the Directory page reads from D1.
// Graph is not called here. A missing sync is an empty list, not a guess.

import { partitionIgnored } from "../lib/directory-ignore";
import { mergeOverlay, type MergedField } from "../lib/directory-merge";

interface ProfileRow {
  aad_id: string;
  mail: string | null;
  display_name: string | null;
  job_title: string | null;
  department: string | null;
  office_location: string | null;
  mobile_phone: string | null;
  business_phones: string;
  city: string | null;
  state: string | null;
  country: string | null;
  account_enabled: number;
  synced_at: string;
}

interface OverlayRow {
  aad_id: string;
  title_override: string | null;
  department_override: string | null;
  city_override: string | null;
  state_override: string | null;
}

interface SocialRow {
  id: string;
  aad_id: string;
  network: string;
  url: string;
  added_by: string;
  added_at: string;
}

export interface DirectoryPerson {
  aadId: string;
  email: string | null;
  displayName: string | null;
  officeLocation: string | null;
  mobilePhone: string | null;
  businessPhones: string[];
  country: string | null;
  active: boolean;
  syncedAt: string;
  title: MergedField;
  department: MergedField;
  city: MergedField;
  state: MergedField;
  socials: SocialRow[];
}

function parsePhones(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((phone): phone is string => typeof phone === "string") : [];
  } catch {
    return [];
  }
}

export async function loadDirectory(env: Env): Promise<{
  people: DirectoryPerson[];
  ignored: DirectoryPerson[];
  syncedAt: string | null;
}> {
  const profiles = (
    await env.DB.prepare(
      `SELECT aad_id, mail, display_name, job_title, department, office_location, mobile_phone,
              business_phones, city, state, country, account_enabled, synced_at
         FROM directory_profiles ORDER BY display_name, mail`
    ).all<ProfileRow>()
  ).results;
  const overlays = (
    await env.DB.prepare(
      `SELECT aad_id, title_override, department_override, city_override, state_override FROM directory_overlay`
    ).all<OverlayRow>()
  ).results;
  const socials = (
    await env.DB.prepare(
      `SELECT id, aad_id, network, url, added_by, added_at FROM directory_social ORDER BY added_at`
    ).all<SocialRow>()
  ).results;
  const overlayById = new Map(overlays.map((row) => [row.aad_id, row]));
  const ignoredRows = (
    await env.DB.prepare(`SELECT aad_id FROM directory_ignored`).all<{ aad_id: string }>()
  ).results;

  const people: DirectoryPerson[] = profiles.map((profile) => {
    const overlay = overlayById.get(profile.aad_id);
    const merged = mergeOverlay(
      {
        jobTitle: profile.job_title,
        department: profile.department,
        city: profile.city,
        state: profile.state,
      },
      overlay
        ? {
            titleOverride: overlay.title_override,
            departmentOverride: overlay.department_override,
            cityOverride: overlay.city_override,
            stateOverride: overlay.state_override,
          }
        : undefined
    );
    return {
      aadId: profile.aad_id,
      email: profile.mail?.toLowerCase() ?? null,
      displayName: profile.display_name,
      officeLocation: profile.office_location,
      mobilePhone: profile.mobile_phone,
      businessPhones: parsePhones(profile.business_phones),
      country: profile.country,
      active: profile.account_enabled === 1,
      syncedAt: profile.synced_at,
      title: merged.title,
      department: merged.department,
      city: merged.city,
      state: merged.state,
      socials: socials.filter((row) => row.aad_id === profile.aad_id),
    };
  });

  const active = people.filter((person) => person.active);
  const split = partitionIgnored(
    active,
    ignoredRows.map((row) => row.aad_id)
  );
  return {
    people: split.visible,
    ignored: split.ignored,
    syncedAt: profiles[0]?.synced_at ?? null,
  };
}
