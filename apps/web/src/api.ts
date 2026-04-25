import { supabase } from "./supabase";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

async function token() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const accessToken = await token();
  if (!accessToken) throw new Error("You are not signed in.");

  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...options.headers
    }
  });

  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body as T;
}

export const money = (value?: number | null) =>
  value == null ? "Missing" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value / 100);

export const moneyRange = (low?: number | null, high?: number | null) => {
  if (low == null || high == null) return "—";
  return `${money(low)} – ${money(high)}`;
};

export const vehicleName = (vehicle?: { year: number | null; make: string | null; model: string | null }) =>
  vehicle ? `${vehicle.year ?? ""} ${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim() || "Your vehicle" : "Your vehicle";
