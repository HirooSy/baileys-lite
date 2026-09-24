/**
 * Username (handle) validation and normalization, matching WhatsApp Web's local rules.
 *
 * NOTE: these limits/pattern are WhatsApp Web's publicly-observable client-side rules
 * (length + charset), reproduced here so callers get a fast local rejection instead of
 * a round trip to the server for obviously invalid input. WhatsApp's server is still the
 * final authority - resolveUsername() below only ever trusts the server's answer.
 */
export const USERNAME_MIN_LENGTH = 4
export const USERNAME_MAX_LENGTH = 30

// Letters, digits, '.' and '_'; must start with a letter (matches WA Web's handle rules).
const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9._]*$/

/**
 * Strips a leading display-only '@' (as pasted from the UI) and trims whitespace.
 * Does not lowercase - WhatsApp usernames are case-insensitive server-side, but we
 * preserve what the caller passed since the server is the source of truth for casing.
 */
export function normalizeUsername(input) {
	if (typeof input !== 'string') return ''
	return input.trim().replace(/^@/, '')
}

/** Local-only validation; does not check availability/existence on the server. */
export function isValidUsername(input) {
	const handle = normalizeUsername(input)
	if (handle.length < USERNAME_MIN_LENGTH || handle.length > USERNAME_MAX_LENGTH) return false
	return USERNAME_PATTERN.test(handle)
}

/** Local-only validation for a 4-digit username lookup key. */
export function isValidUsernameKey(key) {
	return typeof key === 'string' && /^\d{4}$/.test(key)
}
