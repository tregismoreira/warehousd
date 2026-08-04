// Values that must NEVER appear in a response/error/log for a denied field or wrong env.
export const DENIED_CANARY = "CANARY_DENIED_home_address_9f3a";   // planted in people.home_address (synth)
export const SSN_CANARY = "CANARY_SSN_000-00-0000";               // planted in salaries.ssn (synth)
export const LIVE_ONLY_CANARY = "CANARY_LIVE_ONLY_ b2c1";         // planted in data_live rows only
export const DOC_RESTRICTED_CANARY = "DOC-RESTRICTED-CANARY-9e4b"; // planted in restricted doc path (excluded by document_filter)

// Planted through the admin import path (Phase 5) rather than the seeders — imported live
// rows are the only real-shaped data in the system, so the probe suite must cover them.
export const IMPORT_CANARY = "CANARY_IMPORTED_LIVE_5d7e";          // people.full_name (live, imported)
export const IMPORT_DENIED_CANARY = "CANARY_IMPORTED_DENIED_8b2f"; // people.home_address (posture: deny)

// The raw value behind a `posture: { read: mask }` field. Distinct from DENIED_CANARY because it
// tests a different rule: a denied field is never selected at all, while a masked one IS selected
// — as an expression over the raw column — so the raw value exists in the query plan and must
// still never reach a response, an error or a log line. A grant carrying `unmask` is the one
// case where seeing it is correct.
export const MASK_RAW_CANARY = "CANARY_MASK_RAW_4c8d";

// Connect-in-place. Two canaries because an external collection has two distinct ways to leak:
// a row the grant should not reach, and a REMOTE COLUMN warehousd never declared. The second is
// the one the foreign-table design exists to make impossible — columns are written out one at a
// time in the YAML, so a column added upstream is invisible until someone adds it here.
export const EXTERNAL_CANARY = "CANARY_EXTERNAL_ROW_a91f";
export const EXTERNAL_UNDECLARED_CANARY = "CANARY_EXT_UNDECLARED_77b2";
