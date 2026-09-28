// Fixed city centroids for the Directory map. City and state only.
// There is no street, no geocoder, and no maps vendor. A city that is not
// in this table is not plotted.

export interface CityCentroid {
  city: string;
  state: string;
  lat: number;
  lon: number;
}

/** "City|ST|lat|lon" — one row per city the map is willing to plot. */
const ROWS = `
New York|NY|40.7128|-74.0060
Brooklyn|NY|40.6782|-73.9442
Buffalo|NY|42.8864|-78.8784
Rochester|NY|43.1566|-77.6088
Albany|NY|42.6526|-73.7562
Syracuse|NY|43.0481|-76.1474
Jersey City|NJ|40.7178|-74.0431
Newark|NJ|40.7357|-74.1724
Hoboken|NJ|40.7440|-74.0324
Princeton|NJ|40.3573|-74.6672
Trenton|NJ|40.2206|-74.7597
Atlantic City|NJ|39.3643|-74.4229
Cherry Hill|NJ|39.9348|-75.0307
Philadelphia|PA|39.9526|-75.1652
Pittsburgh|PA|40.4406|-79.9959
Allentown|PA|40.6084|-75.4902
Harrisburg|PA|40.2732|-76.8867
Boston|MA|42.3601|-71.0589
Cambridge|MA|42.3736|-71.1097
Worcester|MA|42.2626|-71.8023
Hartford|CT|41.7658|-72.6734
New Haven|CT|41.3083|-72.9279
Stamford|CT|41.0534|-73.5387
Providence|RI|41.8240|-71.4128
Washington|DC|38.9072|-77.0369
Baltimore|MD|39.2904|-76.6122
Annapolis|MD|38.9784|-76.4922
Wilmington|DE|39.7391|-75.5398
Richmond|VA|37.5407|-77.4360
Virginia Beach|VA|36.8529|-75.9780
Arlington|VA|38.8816|-77.0910
Alexandria|VA|38.8048|-77.0469
Norfolk|VA|36.8508|-76.2859
Charlotte|NC|35.2271|-80.8431
Raleigh|NC|35.7796|-78.6382
Durham|NC|35.9940|-78.8986
Charleston|SC|32.7765|-79.9311
Columbia|SC|34.0007|-81.0348
Atlanta|GA|33.7490|-84.3880
Savannah|GA|32.0809|-81.0912
Miami|FL|25.7617|-80.1918
Orlando|FL|28.5383|-81.3792
Tampa|FL|27.9506|-82.4572
Jacksonville|FL|30.3322|-81.6557
Tallahassee|FL|30.4383|-84.2807
Fort Lauderdale|FL|26.1224|-80.1373
Chicago|IL|41.8781|-87.6298
Detroit|MI|42.3314|-83.0458
Ann Arbor|MI|42.2808|-83.7430
Grand Rapids|MI|42.9634|-85.6681
Minneapolis|MN|44.9778|-93.2650
Saint Paul|MN|44.9537|-93.0900
Milwaukee|WI|43.0389|-87.9065
Madison|WI|43.0731|-89.4012
Indianapolis|IN|39.7684|-86.1581
Columbus|OH|39.9612|-82.9988
Cleveland|OH|41.4993|-81.6944
Cincinnati|OH|39.1031|-84.5120
Des Moines|IA|41.5868|-93.6250
Omaha|NE|41.2565|-95.9345
Kansas City|MO|39.0997|-94.5786
St. Louis|MO|38.6270|-90.1994
Kansas City|KS|39.1155|-94.6268
Dallas|TX|32.7767|-96.7970
Fort Worth|TX|32.7555|-97.3308
Houston|TX|29.7604|-95.3698
Austin|TX|30.2672|-97.7431
San Antonio|TX|29.4241|-98.4936
El Paso|TX|31.7619|-106.4850
Plano|TX|33.0198|-96.6989
Oklahoma City|OK|35.4676|-97.5164
Tulsa|OK|36.1540|-95.9928
New Orleans|LA|29.9511|-90.0715
Baton Rouge|LA|30.4515|-91.1871
Birmingham|AL|33.5186|-86.8104
Nashville|TN|36.1627|-86.7816
Memphis|TN|35.1495|-90.0490
Knoxville|TN|35.9606|-83.9207
Louisville|KY|38.2527|-85.7585
Lexington|KY|38.0406|-84.5037
Little Rock|AR|34.7465|-92.2896
Denver|CO|39.7392|-104.9903
Boulder|CO|40.0150|-105.2705
Colorado Springs|CO|38.8339|-104.8214
Phoenix|AZ|33.4484|-112.0740
Tucson|AZ|32.2226|-110.9747
Scottsdale|AZ|33.4942|-111.9261
Las Vegas|NV|36.1699|-115.1398
Reno|NV|39.5296|-119.8138
Salt Lake City|UT|40.7608|-111.8910
Albuquerque|NM|35.0844|-106.6504
Santa Fe|NM|35.6870|-105.9378
Boise|ID|43.6150|-116.2023
Los Angeles|CA|34.0522|-118.2437
San Diego|CA|32.7157|-117.1611
San Francisco|CA|37.7749|-122.4194
San Jose|CA|37.3382|-121.8863
Sacramento|CA|38.5816|-121.4944
Oakland|CA|37.8044|-122.2712
Fresno|CA|36.7378|-119.7871
Long Beach|CA|33.7701|-118.1937
Seattle|WA|47.6062|-122.3321
Tacoma|WA|47.2529|-122.4443
Spokane|WA|47.6588|-117.4260
Portland|OR|45.5152|-122.6784
Eugene|OR|44.0521|-123.0868
Honolulu|HI|21.3069|-157.8583
Anchorage|AK|61.2181|-149.9003
Fairbanks|AK|64.8378|-147.7164
Juneau|AK|58.3019|-134.4197
`.trim();

const STATE_NAMES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

function parseRows(): CityCentroid[] {
  return ROWS.split("\n").map((line) => {
    const [city, state, lat, lon] = line.split("|");
    return { city: city ?? "", state: state ?? "", lat: Number(lat), lon: Number(lon) };
  });
}

export const CITY_CENTROIDS: readonly CityCentroid[] = parseRows();

export function normalizeState(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return STATE_NAMES[trimmed.toLowerCase()] ?? null;
}

export function normalizeCity(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  return trimmed || null;
}

/** City and state, matched against the fixed table. No partial street match. */
export function lookupCentroid(city: string | null | undefined, state: string | null | undefined): CityCentroid | null {
  const wantedCity = normalizeCity(city);
  const wantedState = normalizeState(state);
  if (!wantedCity) return null;
  const matches = CITY_CENTROIDS.filter((row) => normalizeCity(row.city) === wantedCity);
  if (matches.length === 0) return null;
  if (wantedState) return matches.find((row) => row.state === wantedState) ?? null;
  return matches.length === 1 ? matches[0]! : null;
}
