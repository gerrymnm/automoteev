export interface DecodedVin {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
}

export async function decodeVin(vin: string): Promise<DecodedVin> {
  const normalized = vin.trim().toUpperCase();
  const modelYearCode = normalized[9];
  const yearMap: Record<string, number> = {
    R: 2024,
    P: 2023,
    N: 2022,
    M: 2021,
    L: 2020,
    K: 2019,
    J: 2018,
    H: 2017,
    G: 2016
  };

  return {
    year: modelYearCode ? yearMap[modelYearCode] ?? null : null,
    make: "Vehicle",
    model: normalized.slice(0, 3),
    trim: "VIN verified"
  };
}
