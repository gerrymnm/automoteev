/**
 * NHTSA recall integration.
 *
 * NHTSA exposes TWO recall endpoints:
 *
 *   1. By make/model/year (campaign-level):
 *      https://api.nhtsa.gov/recalls/recallsByVehicle?make=X&model=Y&modelYear=Z
 *      Returns ALL campaigns that ever applied to that model-year. Many of
 *      these may have been remedied in subsequent service for any specific VIN.
 *
 *   2. By VIN (VIN-specific, this is what we want):
 *      https://api.nhtsa.gov/recalls/recallsByVin?vin=<vin>
 *      Returns only campaigns that NHTSA shows as still open for THIS VIN.
 *      Empty list = no open recalls.
 *
 * Always prefer the VIN-specific endpoint for live "is my car affected"
 * decisions. The model-year endpoint is only useful for context (e.g.
 * "this model-year had N total campaigns historically"), and we don't
 * surface that to the user because it creates anxiety for no reason.
 */

export interface RecallCampaign {
  nhtsa_campaign_id: string;
  summary: string;
  component: string;
  consequence: string;
  remedy: string;
  reported_at: string | null;
}

export interface RecallResult {
  hasOpenRecall: boolean;
  campaigns: RecallCampaign[];
  summary: string;
  source: "nhtsa_vin" | "nhtsa_model" | "fallback";
}

interface NhtsaCampaign {
  NHTSACampaignNumber?: string;
  Component?: string;
  Summary?: string;
  Consequence?: string;
  Remedy?: string;
  ReportReceivedDate?: string;
}

interface NhtsaRecallResponse {
  results?: NhtsaCampaign[];
  Count?: number;
  Message?: string;
}

/**
 * VIN-specific lookup. THIS is the right call for surfacing recalls to a user.
 * Returns only campaigns that NHTSA shows as still open for the specific VIN.
 */
export async function lookupRecallsByVin(vin: string | null): Promise<RecallResult> {
  if (!vin || vin.trim().length < 11) {
    return {
      hasOpenRecall: false,
      campaigns: [],
      summary: "VIN missing or invalid; recall check skipped.",
      source: "fallback"
    };
  }

  try {
    const url = `https://api.nhtsa.gov/recalls/recallsByVin?vin=${encodeURIComponent(vin.trim())}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`NHTSA ${res.status}`);
    const json = (await res.json()) as NhtsaRecallResponse;

    const campaigns: RecallCampaign[] = (json.results ?? []).map(toCampaign);

    return {
      hasOpenRecall: campaigns.length > 0,
      campaigns,
      summary:
        campaigns.length > 0
          ? `${campaigns.length} open NHTSA recall${campaigns.length === 1 ? "" : "s"} for this VIN.`
          : "No open NHTSA recalls for this VIN.",
      source: "nhtsa_vin"
    };
  } catch (err) {
    return {
      hasOpenRecall: false,
      campaigns: [],
      summary: `VIN recall lookup unavailable (${err instanceof Error ? err.message : "unknown"}).`,
      source: "fallback"
    };
  }
}

/**
 * Legacy model-year lookup. Kept ONLY for cases where we don't have a VIN
 * yet (which shouldn't happen in normal flow — VIN is required at onboarding).
 * Do not call this for live "is this car affected" decisions; it returns
 * historical campaigns that may have been remedied.
 */
export async function lookupRecallsByVehicle(params: {
  make: string | null;
  model: string | null;
  modelYear: number | null;
}): Promise<RecallResult> {
  if (!params.make || !params.model || !params.modelYear) {
    return {
      hasOpenRecall: false,
      campaigns: [],
      summary: "Vehicle identity incomplete; skip until make/model/year decoded.",
      source: "fallback"
    };
  }

  try {
    const url =
      `https://api.nhtsa.gov/recalls/recallsByVehicle` +
      `?make=${encodeURIComponent(params.make)}` +
      `&model=${encodeURIComponent(params.model)}` +
      `&modelYear=${params.modelYear}`;

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`NHTSA ${res.status}`);
    const json = (await res.json()) as NhtsaRecallResponse;

    const campaigns: RecallCampaign[] = (json.results ?? []).map(toCampaign);

    return {
      hasOpenRecall: campaigns.length > 0,
      campaigns,
      summary:
        campaigns.length > 0
          ? `${campaigns.length} historical NHTSA recall(s) for this make/model/year. May not all apply to a specific VIN.`
          : "No NHTSA recalls on file for this make/model/year.",
      source: "nhtsa_model"
    };
  } catch (err) {
    return {
      hasOpenRecall: false,
      campaigns: [],
      summary: `Recall lookup unavailable (${err instanceof Error ? err.message : "unknown"}).`,
      source: "fallback"
    };
  }
}

function toCampaign(r: NhtsaCampaign): RecallCampaign {
  return {
    nhtsa_campaign_id: r.NHTSACampaignNumber ?? "unknown",
    summary: r.Summary ?? "",
    component: r.Component ?? "",
    consequence: r.Consequence ?? "",
    remedy: r.Remedy ?? "",
    reported_at: r.ReportReceivedDate ? toIsoDate(r.ReportReceivedDate) : null
  };
}

function toIsoDate(input: string): string | null {
  // NHTSA returns dates like "15/02/2024". We accept both ISO and slash formats.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const m = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = m[1];
  const mo = m[2];
  const y = m[3];
  if (!d || !mo || !y) return null;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}
