// Values that must NEVER appear in a response/error/log for a denied field or wrong env.
export const DENIED_CANARY = "CANARY_DENIED_home_address_9f3a";   // planted in people.home_address (synth)
export const SSN_CANARY = "CANARY_SSN_000-00-0000";               // planted in salaries.ssn (synth)
export const LIVE_ONLY_CANARY = "CANARY_LIVE_ONLY_ b2c1";         // planted in data_live rows only
export const DOC_RESTRICTED_CANARY = "DOC-RESTRICTED-CANARY-9e4b"; // planted in restricted doc path (excluded by row_filter)
