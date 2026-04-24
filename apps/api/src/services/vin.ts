/**
 * VIN decode via NHTSA vPIC (free, public). Falls back to the prior
 * lightweight local decode if the API is unreachable.
 */

export interface DecodedVin {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  source: "nhtsa" | "local";
}

interface VpicResponse {
  Results?: Array<{
    Variable?: string;
    Value?: string | null;
  }>;
}

function pickValue(results: VpicResponse["Results"], variable: string): string | null {
  const match = results?.find((r) => r.Variable === variable);
  const val = match?.Value;
  if (!val || val === "Not Applicable" || val === "0") return null;
  return val;
}

export async function decodeVin(vin: string): Promise<DecodedVin> {
  const normalized = vin.trim().toUpperCase();

  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${encodeURIComponent(
      normalized
    )}?format=json`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`vPIC ${res.status}`);
    const json = (await res.json()) as VpicResponse;
    const yearStr = pickValue(json.Results, "Model Year");
    return {
      year: yearStr ? Number.parseInt(yearStr, 10) : null,
      make: pickValue(json.Results, "Make"),
      model: pickValue(json.Results, "Model"),
      trim: pickValue(json.Results, "Trim") ?? pickValue(json.Results, "Series"),
      source: "nhtsa"
    };
  } catch {
    return localDecode(normalized);
  }
}

function localDecode(vin: string): DecodedVin {
  const modelYearCode = vin[9];
  const yearMap: Record<string, number> = {
    S: 2025,
    R: 2024,
    P: 2023,
    N: 2022,
    M: 2021,
    L: 2020,
    K: 2019,
    J: 2018,
    H: 2017,
    G: 2016,
    F: 2015,
    E: 2014
  };
  return {
    year: modelYearCode ? yearMap[modelYearCode] ?? null : null,
    make: null,
    model: null,
    trim: null,
    source: "local"
  };
}
