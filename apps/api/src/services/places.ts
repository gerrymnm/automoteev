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

  return places
    .map<FoundProvider>((p) => ({
      external_id: p.id,
      name: p.displayName?.text ?? "Unnamed provider",
      email: null,
      phone: p.nationalPhoneNumber ?? null,
      provider_type: params.providerType,
      location: p.formattedAddress ?? null,
      rating: p.rating ?? null,
      rating_count: p.userRatingCount ?? null,
      website: p.websiteUri ?? null
    }))
    .sort((a, b) => {
      const aScore = (a.rating ?? 0) * Math.log10((a.rating_count ?? 0) + 10);
      const bScore = (b.rating ?? 0) * Math.log10((b.rating_count ?? 0) + 10);
      return bScore - aScore;
    });
}
