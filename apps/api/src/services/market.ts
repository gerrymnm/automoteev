import { env } from "../config.js";

/**
 * Market-aware data: gas prices by state (EIA), regional maintenance cost baseline.
 * Cheap caches below to avoid hammering APIs.
 */

interface GasPriceResult {
  state: string;
  price_per_gallon_usd: number | null;
  as_of: string | null;
  source: "eia" | "fallback";
}

const stateGasCache = new Map<string, { value: GasPriceResult; expires: number }>();
const GAS_TTL_MS = 1000 * 60 * 60 * 12; // 12h

// EIA SERIES IDs for weekly US retail gasoline average (all grades, all formulations)
// State-level series exist for PADD regions; we use national average as default and
// can plug in state-specific series IDs as we confirm them.
const EIA_US_WEEKLY_SERIES = "PET.EMM_EPM0_PTE_NUS_DPG.W";

export async function getGasPrice(state: string | null): Promise<GasPriceResult> {
  const cacheKey = (state ?? "US").toUpperCase();
  const cached = stateGasCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  if (!env.EIA_API_KEY) {
    const fallback: GasPriceResult = {
      state: cacheKey,
      price_per_gallon_usd: 3.35,
      as_of: null,
      source: "fallback"
    };
    stateGasCache.set(cacheKey, { value: fallback, expires: Date.now() + GAS_TTL_MS });
    return fallback;
  }

  try {
    const url = `https://api.eia.gov/v2/seriesid/${EIA_US_WEEKLY_SERIES}?api_key=${env.EIA_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`EIA ${res.status}`);
    const json = (await res.json()) as {
      response?: { data?: Array<{ period: string; value: number }> };
    };
    const latest = json.response?.data?.[0];
    const value: GasPriceResult = {
      state: cacheKey,
      price_per_gallon_usd: latest?.value ?? null,
      as_of: latest?.period ?? null,
      source: "eia"
    };
    stateGasCache.set(cacheKey, { value, expires: Date.now() + GAS_TTL_MS });
    return value;
  } catch {
    const fallback: GasPriceResult = {
      state: cacheKey,
      price_per_gallon_usd: 3.35,
      as_of: null,
      source: "fallback"
    };
    stateGasCache.set(cacheKey, { value: fallback, expires: Date.now() + GAS_TTL_MS });
    return fallback;
  }
}

/**
 * Static cost baseline derived from published RepairPal / industry averages.
 * Replace with RepairPal Fair Price API post-launch when revenue supports it.
 */
export interface MaintenanceCostBaseline {
  item_type: string;
  national_median_cents: number;
  low_cents: number;
  high_cents: number;
}

const BASELINE: Record<string, MaintenanceCostBaseline> = {
  oil_change_conventional: {
    item_type: "oil_change_conventional",
    national_median_cents: 4500,
    low_cents: 3500,
    high_cents: 6500
  },
  oil_change_synthetic: {
    item_type: "oil_change_synthetic",
    national_median_cents: 8500,
    low_cents: 6500,
    high_cents: 12000
  },
  tire_rotation: {
    item_type: "tire_rotation",
    national_median_cents: 3500,
    low_cents: 2000,
    high_cents: 5000
  },
  brake_pads_front: {
    item_type: "brake_pads_front",
    national_median_cents: 25000,
    low_cents: 15000,
    high_cents: 40000
  },
  air_filter: {
    item_type: "air_filter",
    national_median_cents: 4500,
    low_cents: 2500,
    high_cents: 7500
  },
  cabin_filter: {
    item_type: "cabin_filter",
    national_median_cents: 5500,
    low_cents: 3000,
    high_cents: 9000
  },
  battery_replacement: {
    item_type: "battery_replacement",
    national_median_cents: 22000,
    low_cents: 15000,
    high_cents: 35000
  },
  coolant_flush: {
    item_type: "coolant_flush",
    national_median_cents: 13500,
    low_cents: 8000,
    high_cents: 20000
  },
  transmission_fluid: {
    item_type: "transmission_fluid",
    national_median_cents: 20000,
    low_cents: 10000,
    high_cents: 30000
  }
};

// Coarse cost-of-living adjustment by state. Replace with ZIP-level as data permits.
const STATE_MULTIPLIER: Record<string, number> = {
  CA: 1.18,
  NY: 1.18,
  WA: 1.1,
  MA: 1.12,
  HI: 1.25,
  TX: 0.96,
  FL: 0.98,
  OH: 0.92,
  MI: 0.93,
  MS: 0.88,
  AL: 0.89
};

export function getMaintenanceCost(itemType: string, state: string | null): MaintenanceCostBaseline | null {
  const base = BASELINE[itemType];
  if (!base) return null;
  const mult = STATE_MULTIPLIER[(state ?? "").toUpperCase()] ?? 1.0;
  return {
    item_type: base.item_type,
    national_median_cents: Math.round(base.national_median_cents * mult),
    low_cents: Math.round(base.low_cents * mult),
    high_cents: Math.round(base.high_cents * mult)
  };
}

export function listMaintenanceCostKeys(): string[] {
  return Object.keys(BASELINE);
}
