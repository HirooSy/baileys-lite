export const USERNAME_MIN_LENGTH = 4
export const USERNAME_MAX_LENGTH = 30

const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9._]*$/

export function normalizeUsername(input) {
	if (typeof input !== 'string') return ''
	return input.trim().replace(/^@/, '')
}

export function isValidUsername(input) {
	const handle = normalizeUsername(input)
	if (handle.length < USERNAME_MIN_LENGTH || handle.length > USERNAME_MAX_LENGTH) return false
	return USERNAME_PATTERN.test(handle)
}

export function isValidUsernameKey(key) {
	return typeof key === 'string' && /^\d{4}$/.test(key)
}
