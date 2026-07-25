// Values that must NEVER appear in a response/error/log for a denied field or wrong env.
export const DENIED_CANARY = "CANARY_DENIED_home_address_9f3a";   // planted in people.home_address (synth)
export const SSN_CANARY = "CANARY_SSN_000-00-0000";               // planted in salaries.ssn (synth)
export const LIVE_ONLY_CANARY = "CANARY_LIVE_ONLY_ b2c1";         // planted in data_live rows only
export const DOC_RESTRICTED_CANARY = "DOC-RESTRICTED-CANARY-9e4b"; // planted in restricted doc path (excluded by document_filter)

// Planted through the admin import path (Phase 5) rather than the seeders — imported live
// rows are the only real-shaped data in the system, so the probe suite must cover them.
export const IMPORT_CANARY = "CANARY_IMPORTED_LIVE_5d7e";          // people.full_name (live, imported)
export const IMPORT_DENIED_CANARY = "CANARY_IMPORTED_DENIED_8b2f"; // people.home_address (posture: deny)
