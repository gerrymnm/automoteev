/**
 * State → DMV / motor-vehicle agency lookup.
 *
 * Each US state (plus DC) has its own agency, and not all of them are even
 * called "DMV" — Pennsylvania has PennDOT, Illinois uses the Secretary of
 * State, Minnesota has Driver and Vehicle Services, etc. The card in the
 * Home stack needs to surface the right URL and the right human-readable
 * label so "Open DMV" doesn't send a Pennsylvanian to a 404.
 *
 * Per-state we track three things:
 *   - agency_name: display label for the CTA, e.g. "DMV.ca.gov", "PennDOT"
 *   - dl_renewal_url: the deepest stable URL we know for "renew driver's
 *                     license". Falls back to the agency homepage for
 *                     states whose deep links are unstable / undocumented.
 *   - registration_renewal_url: same idea for vehicle registration.
 *
 * If a state isn't found (unknown / null dl_state), the caller should fall
 * back to a neutral phrase ("Open your state DMV") and a search URL or
 * the agency-finder hub at usa.gov.
 *
 * URLs were chosen by picking the most stable landing page each agency
 * publishes for the renewal flow. Some states route everything through a
 * single portal (CA, NY, TX); others split DL from vehicle registration
 * across separate domains (TX has txdps.state.tx.us for DL but txdmv.gov
 * for vehicles). The data here reflects that.
 *
 * If a state's URL goes stale, the failure mode is a 404 in the user's
 * browser — not a server error. The user can still get to the renewal
 * page from the agency homepage, which we always supply as a working
 * URL even when the deep link drifts.
 */

export interface StateDmvInfo {
  agency_name: string;
  dl_renewal_url: string;
  registration_renewal_url: string;
}

// Default fallback used when state is unknown or null. Lands the user on
// usa.gov's state DMV finder which itself routes to the right state.
export const DEFAULT_DMV_INFO: StateDmvInfo = {
  agency_name: "your state DMV",
  dl_renewal_url: "https://www.usa.gov/state-motor-vehicle-services",
  registration_renewal_url: "https://www.usa.gov/state-motor-vehicle-services"
};

// Keyed by 2-letter state code (uppercase). Caller normalizes input.
export const STATE_DMV: Record<string, StateDmvInfo> = {
  AL: {
    agency_name: "Alabama ALEA",
    dl_renewal_url: "https://www.alea.gov/dps/driver-license/online-services",
    registration_renewal_url: "https://www.mvtrip.alabama.gov/"
  },
  AK: {
    agency_name: "Alaska DMV",
    dl_renewal_url: "https://doa.alaska.gov/dmv/akol/akolhome.htm",
    registration_renewal_url: "https://doa.alaska.gov/dmv/akol/akolhome.htm"
  },
  AZ: {
    agency_name: "AZ MVD (ServiceArizona)",
    dl_renewal_url: "https://azdot.gov/motor-vehicles/driver-services/license-renewal",
    registration_renewal_url: "https://azdot.gov/motor-vehicles/vehicle-services/vehicle-registration/renew-your-vehicle-registration"
  },
  AR: {
    agency_name: "Arkansas DFA",
    dl_renewal_url: "https://www.dfa.arkansas.gov/services/category/driver-services/",
    registration_renewal_url: "https://mydmv.arkansas.gov/"
  },
  CA: {
    agency_name: "DMV.ca.gov",
    dl_renewal_url: "https://www.dmv.ca.gov/portal/driver-licenses-identification-cards/renew-driver-license-rdl/",
    registration_renewal_url: "https://www.dmv.ca.gov/portal/vehicle-registration/registration-renewal/"
  },
  CO: {
    agency_name: "Colorado DMV",
    dl_renewal_url: "https://dmv.colorado.gov/driver-license-renewal",
    registration_renewal_url: "https://mydmv.colorado.gov/"
  },
  CT: {
    agency_name: "Connecticut DMV",
    dl_renewal_url: "https://portal.ct.gov/DMV/Online-Services/Driver-License-Online-Services/Online-Driver-License-Renewal",
    registration_renewal_url: "https://portal.ct.gov/DMV/Online-Services/Vehicle-Services/Online-Registration-Renewal"
  },
  DE: {
    agency_name: "Delaware DMV",
    dl_renewal_url: "https://www.dmv.de.gov/services/driver_services/driver_license/dr_lic_renew.shtml",
    registration_renewal_url: "https://dmv.de.gov/services/vehicle_services/vehicle_registration/index.shtml"
  },
  DC: {
    agency_name: "DC DMV",
    dl_renewal_url: "https://dmv.dc.gov/service/renew-your-drivers-license",
    registration_renewal_url: "https://dmv.dc.gov/service/renew-your-vehicle-registration"
  },
  FL: {
    agency_name: "Florida FLHSMV",
    dl_renewal_url: "https://www.flhsmv.gov/driver-licenses-id-cards/renewing-replacing/",
    registration_renewal_url: "https://services.flhsmv.gov/MVCheckWeb/"
  },
  GA: {
    agency_name: "Georgia DDS",
    dl_renewal_url: "https://onlineservices.dds.ga.gov/onlineservices/",
    registration_renewal_url: "https://eservices.drives.ga.gov/"
  },
  HI: {
    agency_name: "Hawaii DMV",
    dl_renewal_url: "https://hidmv.ehawaii.gov/",
    registration_renewal_url: "https://mvr.ehawaii.gov/"
  },
  ID: {
    agency_name: "Idaho ITD",
    dl_renewal_url: "https://itd.idaho.gov/dmv/?target=driver-services",
    registration_renewal_url: "https://itd.idaho.gov/dmv/?target=registration-services"
  },
  IL: {
    agency_name: "IL Secretary of State",
    dl_renewal_url: "https://www.ilsos.gov/departments/drivers/renewals.html",
    registration_renewal_url: "https://www.ilsos.gov/departments/vehicles/renewal/home.html"
  },
  IN: {
    agency_name: "Indiana BMV",
    dl_renewal_url: "https://www.in.gov/bmv/licenses-permits-ids/drivers-licenses/renew-or-replace/",
    registration_renewal_url: "https://www.in.gov/bmv/registration/renew/"
  },
  IA: {
    agency_name: "Iowa DOT",
    dl_renewal_url: "https://iowadot.gov/mvd/driverslicense/renew",
    registration_renewal_url: "https://www.iowatreasurers.org/"
  },
  KS: {
    agency_name: "Kansas DOR",
    dl_renewal_url: "https://www.ksrevenue.gov/dovindex.html",
    registration_renewal_url: "https://www.ikan.ks.gov/"
  },
  KY: {
    agency_name: "Kentucky DVS",
    dl_renewal_url: "https://drive.ky.gov/driver-licensing/Pages/Renewal.aspx",
    registration_renewal_url: "https://drive.ky.gov/motor-vehicle-licensing/Pages/default.aspx"
  },
  LA: {
    agency_name: "Louisiana OMV",
    dl_renewal_url: "https://www.expresslane.org/Pages/default.aspx",
    registration_renewal_url: "https://www.expresslane.org/Pages/default.aspx"
  },
  ME: {
    agency_name: "Maine BMV",
    dl_renewal_url: "https://www.maine.gov/sos/bmv/online/index.html",
    registration_renewal_url: "https://www1.maine.gov/online/bmv/rapid-renewal/"
  },
  MD: {
    agency_name: "Maryland MVA",
    dl_renewal_url: "https://mva.maryland.gov/drivers/Pages/renew-license.aspx",
    registration_renewal_url: "https://mva.maryland.gov/vehicles/Pages/registration-renewal.aspx"
  },
  MA: {
    agency_name: "Massachusetts RMV",
    dl_renewal_url: "https://www.mass.gov/how-to/renew-your-drivers-license-or-id-card",
    registration_renewal_url: "https://www.mass.gov/how-to/renew-your-vehicle-registration"
  },
  MI: {
    agency_name: "Michigan SOS",
    dl_renewal_url: "https://www.michigan.gov/sos/license-id/renewing",
    registration_renewal_url: "https://www.michigan.gov/sos/vehicle/registration"
  },
  MN: {
    agency_name: "Minnesota DVS",
    dl_renewal_url: "https://dps.mn.gov/divisions/dvs/Pages/dvs-content-detail.aspx?pageID=521",
    registration_renewal_url: "https://dps.mn.gov/divisions/dvs/Pages/dvs-content-detail.aspx?pageID=515"
  },
  MS: {
    agency_name: "Mississippi DPS",
    dl_renewal_url: "https://www.driverservicebureau.dps.ms.gov/",
    registration_renewal_url: "https://www.dor.ms.gov/tag-renewal"
  },
  MO: {
    agency_name: "Missouri DOR",
    dl_renewal_url: "https://dor.mo.gov/driver-license/renew/",
    registration_renewal_url: "https://dor.mo.gov/motor-vehicle/registration/renewal/"
  },
  MT: {
    agency_name: "Montana MVD",
    dl_renewal_url: "https://dojmt.gov/driving/renew-or-replace-a-license/",
    registration_renewal_url: "https://dojmt.gov/driving/vehicle-registration/"
  },
  NE: {
    agency_name: "Nebraska DMV",
    dl_renewal_url: "https://dmv.nebraska.gov/dl/online-renewal",
    registration_renewal_url: "https://clickdmv.ne.gov/"
  },
  NV: {
    agency_name: "Nevada DMV",
    dl_renewal_url: "https://dmv.nv.gov/dlrenew.htm",
    registration_renewal_url: "https://dmvapp.nv.gov/dmv/vr/renewal/pages/landing.aspx"
  },
  NH: {
    agency_name: "New Hampshire DMV",
    dl_renewal_url: "https://www.dmv.nh.gov/license-ids/renew-license-or-non-driver-id",
    registration_renewal_url: "https://www.dmv.nh.gov/registrations/renew-vehicle-registration"
  },
  NJ: {
    agency_name: "New Jersey MVC",
    dl_renewal_url: "https://www.nj.gov/mvc/license/renewal.htm",
    registration_renewal_url: "https://www.nj.gov/mvc/vehicles/regrenewal.htm"
  },
  NM: {
    agency_name: "New Mexico MVD",
    dl_renewal_url: "https://www.mvd.newmexico.gov/drivers/getting-a-driver-license/renew-your-driver-license/",
    registration_renewal_url: "https://www.mvd.newmexico.gov/vehicles/registration-renewal/"
  },
  NY: {
    agency_name: "New York DMV",
    dl_renewal_url: "https://dmv.ny.gov/driver-license/renew-driver-license",
    registration_renewal_url: "https://dmv.ny.gov/registration/renew-vehicle-registration"
  },
  NC: {
    agency_name: "North Carolina NCDMV",
    dl_renewal_url: "https://www.ncdot.gov/dmv/license-id/driver-licenses/Pages/renew-license.aspx",
    registration_renewal_url: "https://edmv.ncdot.gov/"
  },
  ND: {
    agency_name: "North Dakota DOT",
    dl_renewal_url: "https://www.dot.nd.gov/divisions/driverslicense/renew.htm",
    registration_renewal_url: "https://www.dot.nd.gov/dotnet/forms/registrationrenewal.aspx"
  },
  OH: {
    agency_name: "Ohio BMV",
    dl_renewal_url: "https://www.bmv.ohio.gov/dl-renew.aspx",
    registration_renewal_url: "https://oplates.com/"
  },
  OK: {
    agency_name: "Oklahoma Service",
    dl_renewal_url: "https://oklahoma.gov/service/all-services/department-public-safety/driver-license/renew-replace.html",
    registration_renewal_url: "https://oklahoma.gov/service.html"
  },
  OR: {
    agency_name: "Oregon DMV",
    dl_renewal_url: "https://www.oregon.gov/odot/DMV/pages/driverid/renewdl.aspx",
    registration_renewal_url: "https://www.oregon.gov/ODOT/DMV/pages/vehicle/renew_reg.aspx"
  },
  PA: {
    agency_name: "PennDOT",
    dl_renewal_url: "https://www.pa.gov/agencies/penndot/driver-vehicle-services/online-services-for-driver-vehicle-and-photo-license/renew-driver-s-license.html",
    registration_renewal_url: "https://www.pa.gov/agencies/penndot/driver-vehicle-services/online-services-for-driver-vehicle-and-photo-license/renew-vehicle-registration.html"
  },
  RI: {
    agency_name: "Rhode Island DMV",
    dl_renewal_url: "https://dmv.ri.gov/renewals/renew-license",
    registration_renewal_url: "https://dmv.ri.gov/renewals/renew-registration"
  },
  SC: {
    agency_name: "South Carolina SCDMV",
    dl_renewal_url: "https://www.scdmvonline.com/",
    registration_renewal_url: "https://www.scdmvonline.com/"
  },
  SD: {
    agency_name: "South Dakota DPS",
    dl_renewal_url: "https://dps.sd.gov/driver-licensing/renewals",
    registration_renewal_url: "https://apps.sd.gov/MV15MVOnlineRenewal/Default.aspx"
  },
  TN: {
    agency_name: "Tennessee DOSHS",
    dl_renewal_url: "https://www.tn.gov/safety/driver-services/renewal.html",
    registration_renewal_url: "https://www.tn.gov/revenue/title-and-registration.html"
  },
  TX: {
    agency_name: "Texas DPS / TxDMV",
    dl_renewal_url: "https://www.dps.texas.gov/section/driver-license/renew-id-card-or-drivers-license",
    registration_renewal_url: "https://www.txdmv.gov/motorists/register-your-vehicle/renew-registration"
  },
  UT: {
    agency_name: "Utah DLD",
    dl_renewal_url: "https://dld.utah.gov/renewing/",
    registration_renewal_url: "https://renewalexpress.utah.gov/"
  },
  VT: {
    agency_name: "Vermont DMV",
    dl_renewal_url: "https://dmv.vermont.gov/licenses/renewing-license",
    registration_renewal_url: "https://dmv.vermont.gov/registrations-titles/renew-registration"
  },
  VA: {
    agency_name: "Virginia DMV",
    dl_renewal_url: "https://www.dmv.virginia.gov/drivers/renew",
    registration_renewal_url: "https://www.dmv.virginia.gov/vehicles/registration"
  },
  WA: {
    agency_name: "Washington DOL",
    dl_renewal_url: "https://www.dol.wa.gov/driver-licenses-and-permits/renew-or-replace-your-driver-license",
    registration_renewal_url: "https://www.dol.wa.gov/vehicles-and-boats/vehicle-registration/renew-vehicle-registration"
  },
  WV: {
    agency_name: "West Virginia DMV",
    dl_renewal_url: "https://transportation.wv.gov/DMV/DriverServices/Pages/RenewLicense.aspx",
    registration_renewal_url: "https://transportation.wv.gov/DMV/Vehicle-Services/Pages/Registration-Renewal.aspx"
  },
  WI: {
    agency_name: "Wisconsin DMV",
    dl_renewal_url: "https://wisconsindmv.gov/license-id/renew-license",
    registration_renewal_url: "https://wisconsindmv.gov/vehicles/title-plates/renew-plates"
  },
  WY: {
    agency_name: "Wyoming DOT",
    dl_renewal_url: "https://www.dot.state.wy.us/home/driver_license_records/dlinfo.html",
    registration_renewal_url: "https://www.dot.state.wy.us/home/titles_plates_registration.html"
  }
};

/**
 * Look up DMV info for a state code. Accepts any-case input ("ca", "CA",
 * "Ca") and trims whitespace. Returns the default fallback when the input
 * is null, empty, or not a recognized state code.
 */
export function dmvForState(stateCode: string | null | undefined): StateDmvInfo {
  if (!stateCode) return DEFAULT_DMV_INFO;
  const normalized = stateCode.trim().toUpperCase();
  if (!normalized) return DEFAULT_DMV_INFO;
  return STATE_DMV[normalized] ?? DEFAULT_DMV_INFO;
}
