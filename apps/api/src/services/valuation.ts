import { env } from "../config.js";

interface ValuationInput {
  vin: string;
  mileage: number;
  zipCode?: string | null;
}

export interface ValuationResult {
  market_value_low_cents: number;
  market_value_high_cents: number;
  dealer_value_low_cents: number;
  dealer_value_high_cents: number;
  basis: string;
  source: "marketcheck";
  is_estimate: true;
}

interface MarketCheckPriceResponse {
  marketcheck_price?: number;
  msrp?: number;
}

const MARKETCHECK_ENDPOINTS = {
  base: "https://api.marketcheck.com/v2/predict/car/us/marketcheck_price",
  premium: "https://api.marketcheck.com/v2/predict/car/us/marketcheck_price/comparables",
  premium_plus: "https://api.marketcheck.com/v2/predict/car/us/marketcheck_price/comparables/decode"
} as const;

export async function getVehicleValuation(input: ValuationInput): Promise<ValuationResult> {
  if (!env.MARKETCHECK_API_KEY) {
    throw new Error("MarketCheck is not configured yet.");
  }
  if (!input.vin || input.vin.length !== 17) {
    throw new Error("A valid 17-character VIN is required for valuation.");
  }
  if (!input.mileage || input.mileage <= 0) {
    throw new Error("Current mileage is required for valuation.");
  }
  if (!input.zipCode) {
    throw new Error("ZIP code is required for local market valuation.");
  }

  const endpoint = MARKETCHECK_ENDPOINTS[env.MARKETCHECK_PRICE_TIER];
  const params = new URLSearchParams({
    api_key: env.MARKETCHECK_API_KEY,
    vin: input.vin.toUpperCase(),
    miles: String(input.mileage),
    dealer_type: env.MARKETCHECK_DEALER_TYPE,
    zip: input.zipCode
  });

  const response = await fetch(`${endpoint}?${params.toString()}`, {
    headers: { Accept: "application/json" }
  });
  const body = (await response.json().catch(() => ({}))) as
    | MarketCheckPriceResponse
    | { message?: string; error?: string };

  if (!response.ok) {
    const message =
      "message" in body && body.message
        ? body.message
        : "error" in body && body.error
        ? body.error
        : "MarketCheck valuation failed.";
    throw new Error(message);
  }

  const marketPriceUsd = "marketcheck_price" in body ? Number(body.marketcheck_price) : NaN;
  if (!Number.isFinite(marketPriceUsd) || marketPriceUsd <= 0) {
    throw new Error("MarketCheck did not return a usable vehicle value.");
  }

  // MarketCheck returns a point prediction. Automoteev displays ranges so users
  // do not treat a single API result like a guaranteed sale or trade-in offer.
  const marketLowUsd = marketPriceUsd * 0.95;
  const marketHighUsd = marketPriceUsd * 1.05;
  const dealerLowUsd = marketPriceUsd * 0.82;
  const dealerHighUsd = marketPriceUsd * 0.9;

  return {
    market_value_low_cents: Math.round(marketLowUsd * 100),
    market_value_high_cents: Math.round(marketHighUsd * 100),
    dealer_value_low_cents: Math.round(dealerLowUsd * 100),
    dealer_value_high_cents: Math.round(dealerHighUsd * 100),
    basis: `MarketCheck price prediction for VIN ${input.vin.toUpperCase()} at ${input.mileage.toLocaleString()} miles in ZIP ${input.zipCode}.`,
    source: "marketcheck",
    is_estimate: true
  };
}
