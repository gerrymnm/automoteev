import { searchProviders, type FoundProvider } from "./places.js";

/**
 * Dealer / provider discovery for a specific task.
 *
 * Picks a search query that matches what the task actually needs:
 *   - recall_repair    → "<Make> dealer service" (brand-specific authorized dealer)
 *   - service_quote    → "auto repair shop"
 *   - insurance_quote  → "auto insurance agency"
 *   - refinance        → "auto loan credit union"
 *   - sell_vehicle     → "we buy cars"
 *
 * Then derives a best-guess service email from each provider's website. We're
 * explicit in the UI that these are guesses — the user can edit before send.
 */

export interface DiscoveredProvider extends FoundProvider {
  derived_email: string | null;
  derived_email_basis: "verified" | "best_guess" | "none";
}

export type DispatchableTaskType =
  | "recall_repair"
  | "service_quote"
  | "insurance_quote"
  | "refinance"
  | "sell_vehicle";

export function isDispatchable(taskType: string): taskType is DispatchableTaskType {
  return [
    "recall_repair",
    "service_quote",
    "insurance_quote",
    "refinance",
    "sell_vehicle"
  ].includes(taskType);
}

/**
 * Map a task to a Places query and the canonical provider_type to store.
 */
function queryForTask(params: {
  taskType: DispatchableTaskType;
  vehicleMake: string | null;
}): { query: string; providerType: string } {
  switch (params.taskType) {
    case "recall_repair": {
      const make = params.vehicleMake?.trim() || "";
      return {
        query: make ? `${make} dealer service` : "auto dealership service",
        providerType: "dealership_service"
      };
    }
    case "service_quote":
      return { query: "auto repair shop", providerType: "service_shop" };
    case "insurance_quote":
      return { query: "auto insurance agency", providerType: "insurance_agent" };
    case "refinance":
      return { query: "auto loan credit union", providerType: "buying_center" };
    case "sell_vehicle":
      return { query: "we buy cars", providerType: "buying_center" };
  }
}

export async function discoverProvidersForTask(params: {
  taskType: DispatchableTaskType;
  vehicleMake: string | null;
  zipCode: string | null;
  maxResults?: number;
}): Promise<DiscoveredProvider[]> {
  const { query, providerType } = queryForTask({
    taskType: params.taskType,
    vehicleMake: params.vehicleMake
  });

  // searchProviders' providerTypeToQuery falls back to `type.replace(/_/g, " ")`
  // for unknown types, so we can pass the literal query string and have it used
  // verbatim. We override providerType on the way out for canonical storage.
  const found = await searchProviders({
    providerType: query,
    zipCode: params.zipCode ?? null
  });

  return found.slice(0, params.maxResults ?? 5).map<DiscoveredProvider>((p) => {
    const derived = deriveServiceEmail(p.website);
    return {
      ...p,
      provider_type: providerType,
      derived_email: derived,
      derived_email_basis: derived ? "best_guess" : "none"
    };
  });
}

/**
 * Pattern-guess a service-department email from a dealership website.
 *   "https://www.landroverroseville.com" → "service@landroverroseville.com"
 * Returns null if no usable domain.
 *
 * This is a guess. The UI marks these as "best guess" and lets the user edit
 * before send. Many dealers have valid service@ mailboxes; many don't. We err
 * toward sending, with explicit user confirmation.
 */
export function deriveServiceEmail(website: string | null): string | null {
  if (!website) return null;
  try {
    const url = new URL(website);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);

    // Skip aggregator / non-dealer domains.
    const skipHosts = [
      "facebook.com",
      "yelp.com",
      "google.com",
      "instagram.com",
      "linkedin.com",
      "carfax.com",
      "cargurus.com",
      "edmunds.com",
      "autotrader.com",
      "cars.com"
    ];
    if (skipHosts.some((h) => host.endsWith(h))) return null;

    // Collapse weird subdomains. "service.landroverroseville.com" → "landroverroseville.com"
    const parts = host.split(".");
    if (parts.length > 2) {
      const tld2 = parts.slice(-2).join(".");
      const knownCompoundTlds = ["co.uk", "com.au", "co.nz", "com.br", "co.jp"];
      if (knownCompoundTlds.includes(tld2)) {
        host = parts.slice(-3).join(".");
      } else {
        host = parts.slice(-2).join(".");
      }
    }
    return `service@${host}`;
  } catch {
    return null;
  }
}
