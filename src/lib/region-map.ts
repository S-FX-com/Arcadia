// Regional map placement. Coordinates come from the fixed centroid table.
// People with no city are unplaced. A city the table does not know is not
// given a guessed pin.

import { lookupCentroid, type CityCentroid } from "./city-centroids";

export interface MapSubject {
  name: string;
  city: string | null;
  state: string | null;
  /** Microsoft 365 country. Shown on Unplaced people. It does not place a pin. */
  country?: string | null;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapDot {
  key: string;
  city: string;
  state: string;
  x: number;
  y: number;
  people: string[];
}

export interface UnmappedPerson {
  name: string;
  city: string;
  state: string | null;
}

export interface UnplacedPerson {
  name: string;
  country: string | null;
}

export interface RegionPlacement {
  dots: MapDot[];
  unplaced: UnplacedPerson[];
  unmapped: UnmappedPerson[];
  outline: MapPoint[];
}

/** Continental United States, as fractions of the map stage (0–100). */
const CONUS = { lonMin: -125, lonMax: -66.5, latMin: 24.2, latMax: 49.4 };

/** A coarse coastline, closed, in lat/lon. Enough to read as the country. */
const OUTLINE: Array<[number, number]> = [
  [48.4, -124.7],
  [49.0, -123.1],
  [49.0, -95.2],
  [48.0, -89.5],
  [46.5, -84.5],
  [45.0, -83.0],
  [43.6, -82.5],
  [42.0, -83.0],
  [41.7, -82.5],
  [42.8, -78.9],
  [43.6, -76.2],
  [44.8, -75.0],
  [45.0, -71.5],
  [44.0, -69.5],
  [41.8, -70.0],
  [41.3, -72.0],
  [40.5, -74.0],
  [39.0, -74.5],
  [38.0, -75.2],
  [36.9, -76.0],
  [35.2, -75.5],
  [33.8, -78.0],
  [32.0, -80.8],
  [30.7, -81.5],
  [29.0, -81.0],
  [27.5, -80.2],
  [25.8, -80.1],
  [25.2, -81.2],
  [26.5, -82.0],
  [28.0, -82.8],
  [29.2, -83.1],
  [30.2, -84.2],
  [30.4, -87.5],
  [30.2, -89.0],
  [29.2, -90.1],
  [29.0, -93.0],
  [29.3, -94.8],
  [27.8, -97.2],
  [26.0, -97.2],
  [25.9, -97.4],
  [29.3, -103.0],
  [31.8, -106.5],
  [31.3, -111.0],
  [32.5, -117.1],
  [34.0, -120.5],
  [36.5, -121.9],
  [38.0, -123.0],
  [40.5, -124.3],
  [42.0, -124.2],
  [46.2, -124.0],
  [48.4, -124.7],
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Equirectangular fit of the continental United States onto 0–100. */
export function projectConus(lat: number, lon: number): MapPoint {
  const x = ((lon - CONUS.lonMin) / (CONUS.lonMax - CONUS.lonMin)) * 100;
  const y = ((CONUS.latMax - lat) / (CONUS.latMax - CONUS.latMin)) * 74;
  return { x: clamp(x, 0, 100), y: clamp(y, 0, 74) };
}

function projectCentroid(row: CityCentroid): MapPoint {
  if (row.state === "AK") {
    const x = ((row.lon - -168) / (-130 - -168)) * 16 + 4;
    const y = ((71 - row.lat) / (71 - 54)) * 16 + 80;
    return { x: clamp(x, 2, 22), y: clamp(y, 78, 98) };
  }
  if (row.state === "HI") {
    const x = ((row.lon - -161) / (-154 - -161)) * 14 + 26;
    const y = ((23 - row.lat) / (23 - 18)) * 14 + 82;
    return { x: clamp(x, 24, 42), y: clamp(y, 80, 98) };
  }
  return projectConus(row.lat, row.lon);
}

function slug(city: string, state: string): string {
  return `${city}-${state}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function placeOnRegionMap(people: MapSubject[]): RegionPlacement {
  const buckets = new Map<string, MapDot>();
  const unplaced: UnplacedPerson[] = [];
  const unmapped: UnmappedPerson[] = [];

  for (const person of people) {
    const city = clean(person.city);
    if (!city) {
      unplaced.push({ name: person.name, country: clean(person.country) });
      continue;
    }
    const centroid = lookupCentroid(city, person.state);
    if (!centroid) {
      unmapped.push({ name: person.name, city, state: person.state });
      continue;
    }
    const key = slug(centroid.city, centroid.state);
    const existing = buckets.get(key);
    if (existing) {
      existing.people.push(person.name);
      continue;
    }
    const point = projectCentroid(centroid);
    buckets.set(key, {
      key,
      city: centroid.city,
      state: centroid.state,
      x: point.x,
      y: point.y,
      people: [person.name],
    });
  }

  const dots = [...buckets.values()].sort((a, b) => a.state.localeCompare(b.state) || a.city.localeCompare(b.city));
  unplaced.sort((a, b) => a.name.localeCompare(b.name));
  unmapped.sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
  return {
    dots,
    unplaced,
    unmapped,
    outline: OUTLINE.map(([lat, lon]) => projectConus(lat, lon)),
  };
}
