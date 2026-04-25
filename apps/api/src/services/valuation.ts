// Vehicle valuation — deterministic estimator. Not as accurate as KBB or
// MarketCheck pricing, but directional. Always returned as a RANGE and
// labeled as an estimate. We can replace this with a paid API later
// (MarketCheck / Black Book) without changing the response shape.

interface ValuationInput {
  year: number | null;
  make: string | null;
  model: string | null;
  mileage: number;
  condition?: "excellent" | "good" | "fair" | "poor";
}

export interface ValuationResult {
  market_value_low_cents: number;
  market_value_high_cents: number;
  dealer_value_low_cents: number;
  dealer_value_high_cents: number;
  basis: string; // human-readable explanation of how we got there
  source: "automoteev_estimate";
  is_estimate: true;
}

/**
 * Rough segment baseline new-vehicle price in USD. Used when we don't
 * have a model-specific table entry. These numbers are kept conservative
 * and lean toward the volume midpoint of each segment.
 */
const SEGMENT_DEFAULTS: Record<string, number> = {
  compact_car: 24_000,
  midsize_car: 30_000,
  full_size_car: 38_000,
  compact_suv: 32_000,
  midsize_suv: 42_000,
  full_size_suv: 65_000,
  pickup: 50_000,
  luxury_car: 60_000,
  luxury_suv: 75_000,
  ev: 45_000,
  unknown: 32_000
};

/**
 * Very small known-model overrides. We can grow this table over time;
 * everything else falls back to a segment-based guess. The intent here
 * is to be roughly right, not perfectly right. Values are MSRP-ish in
 * USD for a fairly recent model year.
 */
const MODEL_BASELINE_USD: Record<string, number> = {
  "toyota:camry": 28_000,
  "toyota:corolla": 22_500,
  "toyota:rav4": 30_500,
  "toyota:highlander": 41_000,
  "toyota:tacoma": 33_000,
  "toyota:tundra": 41_000,
  "honda:civic": 24_000,
  "honda:accord": 28_500,
  "honda:cr-v": 30_000,
  "honda:pilot": 41_000,
  "ford:f-150": 40_000,
  "ford:ranger": 28_000,
  "ford:explorer": 39_000,
  "ford:escape": 29_000,
  "chevrolet:silverado 1500": 39_000,
  "chevrolet:malibu": 26_000,
  "chevrolet:equinox": 28_000,
  "chevrolet:tahoe": 56_000,
  "nissan:altima": 26_500,
  "nissan:rogue": 29_000,
  "nissan:sentra": 21_500,
  "hyundai:elantra": 22_000,
  "hyundai:tucson": 28_500,
  "hyundai:santa fe": 31_000,
  "kia:forte": 21_500,
  "kia:sorento": 32_000,
  "kia:sportage": 28_000,
  "subaru:outback": 30_000,
  "subaru:forester": 28_500,
  "subaru:crosstrek": 26_500,
  "mazda:cx-5": 30_000,
  "mazda:cx-30": 25_500,
  "mazda:3": 24_000,
  "tesla:model 3": 42_000,
  "tesla:model y": 49_000,
  "tesla:model s": 78_000,
  "tesla:model x": 90_000,
  "bmw:3 series": 45_000,
  "bmw:5 series": 56_000,
  "bmw:x3": 48_000,
  "bmw:x5": 67_000,
  "mercedes-benz:c-class": 47_000,
  "mercedes-benz:e-class": 58_000,
  "mercedes-benz:gle": 64_000,
  "audi:a4": 41_000,
  "audi:q5": 47_000,
  "audi:q7": 60_000,
  "lexus:rx": 51_000,
  "lexus:nx": 41_000,
  "lexus:es": 43_000,
  "jeep:wrangler": 35_000,
  "jeep:grand cherokee": 41_000,
  "jeep:cherokee": 31_000,
  "ram:1500": 41_000,
  "gmc:sierra 1500": 41_000,
  "gmc:yukon": 60_000,
  "volkswagen:jetta": 22_000,
  "volkswagen:tiguan": 28_000,
  "volkswagen:atlas": 38_000
};

export function estimateVehicleValue(input: ValuationInput): ValuationResult | null {
  if (!input.year || !input.make || !input.model) return null;
  const currentYear = new Date().getFullYear();
  const age = Math.max(0, currentYear - input.year);

  const baseline = baselineForVehicle(input.make, input.model);

  // Depreciation curve: ~20% year 1, ~15% years 2-3, ~10% years 4-7, ~7% afterward.
  let multiplier = 1;
  for (let y = 1; y <= age; y++) {
    if (y === 1) multiplier *= 0.8;
    else if (y <= 3) multiplier *= 0.85;
    else if (y <= 7) multiplier *= 0.9;
    else multiplier *= 0.93;
  }
  const depreciatedUsd = baseline * multiplier;

  // Mileage adjustment: assume 12,000 mi/yr is "typical." Every 1,000 mi over
  // typical reduces value ~$80; every 1,000 mi under typical adds ~$50.
  const expectedMiles = age * 12_000;
  const milesDelta = input.mileage - expectedMiles;
  const mileageAdj = milesDelta >= 0 ? -1 * (milesDelta / 1000) * 80 : -1 * (milesDelta / 1000) * 50;
  const mileageAdjustedUsd = Math.max(1500, depreciatedUsd + mileageAdj);

  // Condition adjustment.
  const conditionMultiplier =
    input.condition === "excellent"
      ? 1.05
      : input.condition === "fair"
      ? 0.92
      : input.condition === "poor"
      ? 0.8
      : 1;
  const finalUsd = mileageAdjustedUsd * conditionMultiplier;

  // Market (private-party) is the headline number. Range is +/- 7% to reflect
  // local market noise. Dealer trade-in is typically 80-87% of private-party.
  const marketLowUsd = finalUsd * 0.93;
  const marketHighUsd = finalUsd * 1.07;
  const dealerLowUsd = finalUsd * 0.8;
  const dealerHighUsd = finalUsd * 0.87;

  return {
    market_value_low_cents: Math.round(marketLowUsd * 100),
    market_value_high_cents: Math.round(marketHighUsd * 100),
    dealer_value_low_cents: Math.round(dealerLowUsd * 100),
    dealer_value_high_cents: Math.round(dealerHighUsd * 100),
    basis: `Estimate based on ${input.year} ${input.make} ${input.model}, ${input.mileage.toLocaleString()} mi, age-based depreciation.`,
    source: "automoteev_estimate",
    is_estimate: true
  };
}

function baselineForVehicle(make: string, model: string): number {
  const key = `${make.toLowerCase()}:${model.toLowerCase()}`;
  if (MODEL_BASELINE_USD[key]) return MODEL_BASELINE_USD[key]!;

  // Fallback: classify by make-only segment.
  const m = make.toLowerCase();
  if (["bmw", "mercedes-benz", "audi", "lexus", "porsche", "infiniti", "acura", "cadillac", "lincoln", "genesis", "land rover", "volvo"].includes(m)) {
    return SEGMENT_DEFAULTS.luxury_car!;
  }
  if (m === "tesla") return SEGMENT_DEFAULTS.ev!;
  if (["ram", "ford", "chevrolet", "gmc", "toyota", "nissan"].includes(m)) {
    // Default to midsize; pickups / large SUVs are more common queries here.
    return SEGMENT_DEFAULTS.midsize_suv!;
  }
  return SEGMENT_DEFAULTS.unknown!;
}
