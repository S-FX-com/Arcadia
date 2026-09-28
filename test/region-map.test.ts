import { describe, expect, it } from "vitest";
import { lookupCentroid } from "../src/lib/city-centroids";
import { placeOnRegionMap } from "../src/lib/region-map";

describe("city centroids", () => {
  it("matches a city and state and refuses a street-shaped miss", () => {
    expect(lookupCentroid("Chicago", "IL")?.city).toBe("Chicago");
    expect(lookupCentroid("chicago", "Illinois")?.state).toBe("IL");
    expect(lookupCentroid("123 Main Street", "IL")).toBeNull();
    expect(lookupCentroid("Kansas City", "KS")?.state).toBe("KS");
    expect(lookupCentroid("Kansas City", null)).toBeNull();
  });
});

describe("region map", () => {
  const placed = placeOnRegionMap([
    { name: "Ada", city: "Seattle", state: "WA" },
    { name: "Bea", city: "Miami", state: "FL" },
    { name: "Cal", city: "New York", state: "NY" },
    { name: "Dee", city: null, state: "NJ" },
    { name: "Eli", city: "  ", state: null },
    { name: "Fay", city: "Springfield", state: "IL" },
  ]);

  it("plots known cities and leaves people with no city unplaced", () => {
    expect(placed.dots.map((dot) => dot.city).sort()).toEqual(["Miami", "New York", "Seattle"]);
    expect(placed.unplaced).toEqual(["Dee", "Eli"]);
    expect(placed.unmapped.map((row) => row.name)).toEqual(["Fay"]);
  });

  it("puts the west coast left of the east coast and the south below the north", () => {
    const seattle = placed.dots.find((dot) => dot.city === "Seattle");
    const miami = placed.dots.find((dot) => dot.city === "Miami");
    const nyc = placed.dots.find((dot) => dot.city === "New York");
    expect(seattle && nyc && seattle.x < nyc.x).toBe(true);
    expect(miami && nyc && miami.y > nyc.y).toBe(true);
  });
});
