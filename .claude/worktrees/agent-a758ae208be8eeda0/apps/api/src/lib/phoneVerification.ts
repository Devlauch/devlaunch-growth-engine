/**
 * Basic, honest phone number handling for discovered contacts.
 *
 * We do NOT fabricate carrier/line-type lookups (that needs a paid
 * provider we don't have). What we do for real:
 *  - normalize formatting (strip spaces, dashes, dots, parens)
 *  - require E.164 shape: a leading "+", a plausible country calling
 *    code (1-3 digits, no leading 0), and a plausible overall length
 *    (E.164 caps subscriber numbers at 15 digits total).
 */

export interface PhoneVerificationResult {
  normalized: string | null;
  isPlausibleE164: boolean;
}

/**
 * Strips common formatting characters (spaces, dashes, dots, parens) and
 * collapses a leading "00" international prefix to "+". Does not attempt
 * to add a country code if one isn't present — we don't know the
 * contact's country, so guessing would be dishonest.
 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (value.length === 0) return null;

  // Strip everything except leading + and digits.
  const hasLeadingPlus = value.startsWith("+");
  value = value.replace(/[^\d]/g, "");
  if (hasLeadingPlus) {
    value = `+${value}`;
  } else if (value.startsWith("00")) {
    value = `+${value.slice(2)}`;
  }

  if (!value.startsWith("+")) return null;

  const digits = value.slice(1);
  if (digits.length === 0) return null;

  return `+${digits}`;
}

/**
 * E.164-ish plausibility check: "+", country calling code not starting
 * with 0, total digit count between 8 and 15 (E.164's hard max, with a
 * floor to reject obviously-too-short numbers).
 */
export function isPlausibleE164(value: string): boolean {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return false;
  return true;
}

export function verifyPhone(input: string): PhoneVerificationResult {
  const normalized = normalizePhone(input);
  if (!normalized) {
    return { normalized: null, isPlausibleE164: false };
  }
  return { normalized, isPlausibleE164: isPlausibleE164(normalized) };
}
