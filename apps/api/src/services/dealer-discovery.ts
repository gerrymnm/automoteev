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
 * For each discovered dealer, attempts to VERIFY a contact email by scraping
 * the dealer's website (homepage + /contact pages). We never guess emails —
 * a dealer either has a verified email we found published on their site, or
 * we surface them as phone/website-only and skip them in email outreach.
 */

export interface DiscoveredProvider extends FoundProvider {
  /** Email scraped from the dealer's website. Null if none found. */
  derived_email: string | null;
  /** "verified" = scraped from a public page; "none" = not found. We do NOT guess. */
  derived_email_basis: "verified" | "none";
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

  const found = await searchProviders({
    providerType: query,
    zipCode: params.zipCode ?? null
  });

  const candidates = found.slice(0, params.maxResults ?? 5);

  // Scrape websites in parallel for verified emails. Bounded concurrency via
  // Promise.all on a small list. Each fetch has its own timeout.
  const enriched = await Promise.all(
    candidates.map(async (p): Promise<DiscoveredProvider> => {
      const verified = p.website
        ? await scrapeVerifiedEmailFromWebsite(p.website)
        : null;
      return {
        ...p,
        provider_type: providerType,
        derived_email: verified,
        derived_email_basis: verified ? "verified" : "none"
      };
    })
  );

  return enriched;
}

/**
 * Try to find a verified contact email on a dealer website. We check the
 * homepage, then /contact and /contact-us. We look for mailto: links first
 * (most reliable), then visible email patterns in HTML.
 *
 * Hard rule: NEVER guess. We only return an email that was actually published
 * on the dealer's own site. If we can't find one, we return null and the UI
 * surfaces phone/website outreach instead.
 */
export async function scrapeVerifiedEmailFromWebsite(
  websiteUrl: string
): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const u = new URL(websiteUrl);
    candidates.push(u.toString());
    candidates.push(new URL("/contact", u.origin).toString());
    candidates.push(new URL("/contact-us", u.origin).toString());
  } catch {
    return null;
  }

  for (const url of candidates) {
    const email = await scrapeEmailFromUrl(url);
    if (email) return email;
  }
  return null;
}

async function scrapeEmailFromUrl(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Automoteev/1.0; +https://automoteev.com)",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) return null;
    const html = await res.text();

    // 1) mailto: links — strongest signal that the dealer actually checks the inbox.
    const mailtoMatch = html.match(
      /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i
    );
    if (mailtoMatch && mailtoMatch[1]) {
      const candidate = mailtoMatch[1].toLowerCase().trim();
      if (isValidEmail(candidate) && !isJunkEmail(candidate)) return candidate;
    }

    // 2) Visible email patterns. Filter aggressively, then prefer service@/sales@.
    const pattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = html.match(pattern) ?? [];
    const filtered = Array.from(
      new Set(matches.map((e) => e.toLowerCase().trim()))
    )
      .filter(isValidEmail)
      .filter((e) => !isJunkEmail(e));

    if (filtered.length === 0) return null;

    // Prefer service-department first, then sales, then info/contact, then any.
    const preferences = ["service@", "sales@", "info@", "contact@", "customerservice@"];
    for (const pref of preferences) {
      const match = filtered.find((e) => e.startsWith(pref));
      if (match) return match;
    }
    return filtered[0] ?? null;
  } catch {
    return null;
  }
}

function isValidEmail(email: string): boolean {
  if (email.length < 5 || email.length > 100) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);
}

function isJunkEmail(email: string): boolean {
  const lower = email.toLowerCase();
  const junkSubstrings = [
    "example.com",
    "example.org",
    "yourdomain",
    "domain.com",
    "sentry.io",
    "wixpress.com",
    "schema.org",
    "wordpress.com",
    "gravatar.com",
    "googletagmanager",
    "googleanalytics",
    "facebook.com",
    "fbcdn.net",
    "cloudflare.com",
    "@2x",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp"
  ];
  if (junkSubstrings.some((j) => lower.includes(j))) return true;
  // Drop no-reply / do-not-reply addresses — they don't accept inbound mail.
  if (/^(no.?reply|do.?not.?reply|noreply)@/.test(lower)) return true;
  return false;
}
