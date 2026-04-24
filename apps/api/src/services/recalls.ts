/**
 * Real NHTSA integration for recall lookup.
 * API: https://api.nhtsa.gov/recalls/recallsByVehicle?make=&model=&modelYear=
 * There is no direct "by VIN" endpoint, so we decode VIN first via vPIC,
 * then query recalls by make/model/modelYear.
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
  source: "nhtsa" | "fallback";
}

interface NhtsaRecallResponse {
  results?: Array<{
    NHTSACampaignNumber?: string;
    Component?: string;
    Summary?: string;
    Consequence?: string;
    Remedy?: string;
    ReportReceivedDate?: string;
  }>;
}

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

    const campaigns: RecallCampaign[] = (json.results ?? []).map((r) => ({
      nhtsa_campaign_id: r.NHTSACampaignNumber ?? "unknown",
      summary: r.Summary ?? "",
      component: r.Component ?? "",
      consequence: r.Consequence ?? "",
      remedy: r.Remedy ?? "",
      reported_at: r.ReportReceivedDate ? toIsoDate(r.ReportReceivedDate) : null
    }));

    return {
      hasOpenRecall: campaigns.length > 0,
      campaigns,
      summary:
        campaigns.length > 0
          ? `${campaigns.length} NHTSA recall campaign(s) match this vehicle.`
          : "No NHTSA recalls on file for this make/model/year.",
      source: "nhtsa"
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
