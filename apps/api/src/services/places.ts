import { env } from "../config.js";
import type { ProviderInput } from "./providers.js";

/**
 * Google Places lookup for vendor discovery. Returns nearest, highest-rated
 * providers of a given type within a radius of the owner's ZIP/coords.
 */

interface PlacesTextSearchResponse {
  places?: Array<{
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    rating?: number;
    userRatingCount?: number;
    nationalPhoneNumber?: string;
    websiteUri?: string;
    location?: { latitude: number; longitude: number };
  }>;
}

function providerTypeToQuery(type: string): string {
  const map: Record<string, string> = {
    service_shop: "auto repair shop",
    dealership_service: "dealership service center",
    oil_change: "oil change",
    tire_shop: "tire shop",
    body_shop: "auto body shop",
    insurance_agent: "insurance agency",
    buying_center: "car buying center"
  };
  return map[type] ?? type.replace(/_/g, " ");
}

export interface FoundProvider extends ProviderInput {
  external_id: string;
  rating: number | null;
  rating_count: number | null;
  website: string | null;
  /** Latitude/longitude from Google Places. Used for distance-weighted ranking. */
  lat: number | null;
  lng: number | null;
}

/**
 * Geocode a US ZIP code to lat/lng using Google Geocoding API.
 * Returns null if the API key is missing, the ZIP can't be resolved, or any
 * network error occurs. Cached in-memory per process so the same ZIP is only
 * resolved once per Railway instance lifetime.
 */
const zipCache = new Map<string, { lat: number; lng: number } | null>();
export async function geocodeZip(
  zipCode: string
): Promise<{ lat: number; lng: number } | null> {
  if (!env.GOOGLE_MAPS_API_KEY) {
    console.warn("[geocode] GOOGLE_MAPS_API_KEY missing — distance ranking disabled");
    return null;
  }
  const normalized = zipCode.trim();
  if (!/^\d{5}$/.test(normalized)) {
    console.warn(`[geocode] invalid ZIP shape: ${zipCode}`);
    return null;
  }
  if (zipCache.has(normalized)) return zipCache.get(normalized) ?? null;

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?components=postal_code:${normalized}|country:US&key=${env.GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[geocode] HTTP ${res.status} for ZIP ${normalized}`);
      zipCache.set(normalized, null);
      return null;
    }
    const json = (await res.json()) as {
      status?: string;
      error_message?: string;
      results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }>;
    };
    const loc = json.results?.[0]?.geometry?.location;
    if (json.status === "OK" && loc?.lat != null && loc?.lng != null) {
      const result = { lat: loc.lat, lng: loc.lng };
      zipCache.set(normalized, result);
      console.log(`[geocode] resolved ${normalized} → ${result.lat.toFixed(4)},${result.lng.toFixed(4)}`);
      return result;
    }
    // Common failure modes: REQUEST_DENIED (key restricted), OVER_QUERY_LIMIT,
    // ZERO_RESULTS. We log status + error_message so we can tell which one.
    console.warn(
      `[geocode] non-OK status for ZIP ${normalized}: status=${json.status} message=${json.error_message ?? "(none)"}`
    );
    zipCache.set(normalized, null);
    return null;
  } catch (err) {
    console.warn(`[geocode] threw for ZIP ${normalized}:`, err);
    zipCache.set(normalized, null);
    return null;
  }
}

/**
 * Haversine distance between two lat/lng points, in miles.
 * Used to rank dealers by how convenient they actually are for the user.
 */
export function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function searchProviders(params: {
  providerType: string;
  zipCode?: string | null;
  lat?: number;
  lng?: number;
  radiusMiles?: number;
}): Promise<FoundProvider[]> {
  if (!env.GOOGLE_MAPS_API_KEY) return [];

  const query = providerTypeToQuery(params.providerType);
  const queryWithZip = params.zipCode ? `${query} near ${params.zipCode}` : query;

  const body: Record<string, unknown> = {
    textQuery: queryWithZip,
    maxResultCount: 10
  };
  if (params.lat != null && params.lng != null && params.radiusMiles) {
    body.locationBias = {
      circle: {
        center: { latitude: params.lat, longitude: params.lng },
        radius: params.radiusMiles * 1609.34
      }
    };
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.rating",
        "places.userRatingCount",
        "places.nationalPhoneNumber",
        "places.websiteUri",
        "places.location"
      ].join(",")
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) return [];
  const json = (await res.json()) as PlacesTextSearchResponse;
  const places = json.places ?? [];

  return places.map<FoundProvider>((p) => ({
    external_id: p.id,
    name: p.displayName?.text ?? "Unnamed provider",
    email: null,
    phone: p.nationalPhoneNumber ?? null,
    provider_type: params.providerType,
    location: p.formattedAddress ?? null,
    rating: p.rating ?? null,
    rating_count: p.userRatingCount ?? null,
    website: p.websiteUri ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null
  }));
  // Note: ranking happens in dealer-discovery.ts with distance + rating weights,
  // since that's where we have the user's lat/lng.
}
