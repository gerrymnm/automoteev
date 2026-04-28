/**
 * Shared business directory + verified-contacts pool.
 *
 * Up to migration 010 every provider was per-user. When user A's outreach to
 * Land Rover Marin learned that Alex Perry replies for service, that learning
 * sat on user A's `providers.contacts` row only. User B onboarding next month
 * would re-discover Land Rover Marin from scratch and start cold.
 *
 * Migration 011 introduces this layer:
 *   - `businesses` is the shared directory, keyed on Google Places `place_id`.
 *   - `business_contacts` is the shared verified-emails pool. One row per
 *     (business_id, email, dept). Reused across all users.
 *   - `providers.business_id` links the existing per-user table to the shared
 *     directory.
 *
 * Send-to email priority becomes:
 *   1. User's own per-dept learned contact  (providers.contacts[dept])
 *   2. Community-verified contact            (business_contacts → most recent)
 *   3. Published email scraped from website  (providers.email)
 *
 * The directory is service-role only — RLS denies authenticated/anon. All
 * reads happen through the API.
 */

import { supabaseAdmin } from "../supabase.js";

export interface BusinessRecord {
  id: string;
  place_id: string | null;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  provider_type: string | null;
  published_email: string | null;
  rating: number | null;
  rating_count: number | null;
}

export interface SharedContact {
  email: string;
  dept: string;
  contact_name: string | null;
  success_count: number;
  last_success_at: string;
}

/**
 * Find the businesses row matching a discovered provider, creating it if not
 * found. Match priority: place_id (when available) > (name, address). Returns
 * the canonical business id so the per-user provider row can link to it.
 */
export async function upsertBusiness(params: {
  place_id?: string | null;
  name: string;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  provider_type?: string | null;
  published_email?: string | null;
  rating?: number | null;
  rating_count?: number | null;
  latitude?: number | null;
  longitude?: number | null;
}): Promise<BusinessRecord | null> {
  // 1. Try place_id first — that's the canonical Google identity. When it
  //    matches, refresh metadata that may have changed (rating, phone, etc).
  if (params.place_id) {
    const { data: existing } = await supabaseAdmin
      .from("businesses")
      .select("*")
      .eq("place_id", params.place_id)
      .maybeSingle();

    if (existing) {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      // Only fill in fields we currently lack — never overwrite a value the
      // directory already has unless we explicitly received a fresher one.
      if (!existing.published_email && params.published_email) updates.published_email = params.published_email;
      if (!existing.phone && params.phone) updates.phone = params.phone;
      if (!existing.website && params.website) updates.website = params.website;
      if (!existing.address && params.address) updates.address = params.address;
      if (params.rating != null) updates.rating = params.rating;
      if (params.rating_count != null) updates.rating_count = params.rating_count;
      if (params.latitude != null && existing.latitude == null) updates.latitude = params.latitude;
      if (params.longitude != null && existing.longitude == null) updates.longitude = params.longitude;

      if (Object.keys(updates).length > 1) {
        await supabaseAdmin.from("businesses").update(updates).eq("id", existing.id);
      }
      return existing as BusinessRecord;
    }
  }

  // 2. Fall back to (name, address) match — used during backfill before
  //    place_ids are populated, and as a safety net if place_id is missing.
  const nameLower = params.name.trim().toLowerCase();
  const addressLower = (params.address ?? "").trim().toLowerCase();
  const { data: byNameAddress } = await supabaseAdmin
    .from("businesses")
    .select("*")
    .ilike("name", params.name.trim())
    .limit(20);

  const match = (byNameAddress ?? []).find(
    (b: any) =>
      (b.name as string).trim().toLowerCase() === nameLower &&
      ((b.address as string | null) ?? "").trim().toLowerCase() === addressLower
  );

  if (match) {
    // If we now have a place_id and the row didn't, attach it.
    if (params.place_id && !match.place_id) {
      await supabaseAdmin
        .from("businesses")
        .update({ place_id: params.place_id, updated_at: new Date().toISOString() })
        .eq("id", match.id);
    }
    return match as BusinessRecord;
  }

  // 3. Insert a new row.
  const { data: created, error } = await supabaseAdmin
    .from("businesses")
    .insert({
      place_id: params.place_id ?? null,
      name: params.name.trim(),
      address: params.address ?? null,
      phone: params.phone ?? null,
      website: params.website ?? null,
      latitude: params.latitude ?? null,
      longitude: params.longitude ?? null,
      provider_type: params.provider_type ?? null,
      published_email: params.published_email ?? null,
      rating: params.rating ?? null,
      rating_count: params.rating_count ?? null
    })
    .select()
    .single();

  if (error) {
    // Race condition: someone else just created the same row. Retry the lookup.
    if (params.place_id) {
      const { data: existing } = await supabaseAdmin
        .from("businesses")
        .select("*")
        .eq("place_id", params.place_id)
        .maybeSingle();
      if (existing) return existing as BusinessRecord;
    }
    console.error("[business-directory] upsertBusiness failed", error);
    return null;
  }
  return created as BusinessRecord;
}

/**
 * Look up the most-recently-verified shared contact at a business for a given
 * department. Returns null when no community contact exists.
 *
 * Most-recent wins on the assumption that fresher contacts reflect current
 * staffing. If two users learn different reps at the same dealership, the
 * one that replied most recently is more likely to still be there.
 */
export async function lookupSharedContact(params: {
  business_id: string;
  dept: string;
}): Promise<SharedContact | null> {
  const { data, error } = await supabaseAdmin
    .from("business_contacts")
    .select("email, dept, contact_name, success_count, last_success_at")
    .eq("business_id", params.business_id)
    .eq("dept", params.dept)
    .order("last_success_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[business-directory] lookupSharedContact failed", error);
    return null;
  }
  return (data as SharedContact | null) ?? null;
}

/**
 * Bulk lookup — given a list of business_ids and a department, return a map
 * from business_id to the freshest shared contact. Used by buildDispatchPayload
 * to annotate every provider row in one query rather than N queries.
 */
export async function lookupSharedContactsBulk(params: {
  business_ids: string[];
  dept: string;
}): Promise<Map<string, SharedContact>> {
  const out = new Map<string, SharedContact>();
  if (params.business_ids.length === 0) return out;

  const { data, error } = await supabaseAdmin
    .from("business_contacts")
    .select("business_id, email, dept, contact_name, success_count, last_success_at")
    .in("business_id", params.business_ids)
    .eq("dept", params.dept)
    .order("last_success_at", { ascending: false });

  if (error) {
    console.error("[business-directory] lookupSharedContactsBulk failed", error);
    return out;
  }

  // First row wins per business_id since we sorted by last_success_at desc.
  for (const row of data ?? []) {
    const r = row as any;
    if (!out.has(r.business_id)) {
      out.set(r.business_id, {
        email: r.email,
        dept: r.dept,
        contact_name: r.contact_name,
        success_count: r.success_count,
        last_success_at: r.last_success_at
      });
    }
  }
  return out;
}

/**
 * Record that a verified email at a business successfully replied for a
 * department. Called from the inbound webhook after the per-user learning
 * step writes to providers.contacts[dept]. Idempotent — calling it again
 * for the same (business, email, dept) just bumps success_count.
 */
export async function recordVerifiedContact(params: {
  business_id: string;
  email: string;
  dept: string;
  contact_name?: string | null;
  user_id: string;
}): Promise<void> {
  const now = new Date().toISOString();

  // Try to update an existing row first (bump success_count + freshen
  // last_success_at). If no row exists, insert.
  const { data: existing } = await supabaseAdmin
    .from("business_contacts")
    .select("id, success_count, contact_name")
    .eq("business_id", params.business_id)
    .eq("email", params.email)
    .eq("dept", params.dept)
    .maybeSingle();

  if (existing) {
    const updates: Record<string, unknown> = {
      success_count: ((existing as any).success_count ?? 0) + 1,
      last_success_at: now
    };
    // Backfill contact_name if we have it now and didn't before.
    if (params.contact_name && !(existing as any).contact_name) {
      updates.contact_name = params.contact_name;
    }
    await supabaseAdmin
      .from("business_contacts")
      .update(updates)
      .eq("id", (existing as any).id);
    return;
  }

  // Insert. ON CONFLICT defends against the race where two webhooks fire
  // simultaneously for the same business+email+dept.
  const { error } = await supabaseAdmin.from("business_contacts").insert({
    business_id: params.business_id,
    email: params.email,
    dept: params.dept,
    contact_name: params.contact_name ?? null,
    verified_by_user_id: params.user_id,
    verified_at: now,
    last_success_at: now,
    success_count: 1
  });

  if (error) {
    // 23505 = unique_violation. The row was just inserted by a concurrent
    // request — non-fatal; we'll bump success_count next time.
    if ((error as any).code !== "23505") {
      console.error("[business-directory] recordVerifiedContact insert failed", error);
    }
  }
}
