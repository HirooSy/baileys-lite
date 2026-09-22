/**
 * Native replacements for the four `whatsapp-rust-bridge` (WASM) functions
 * that baileys-lite used: md5, hkdf, expandAppStateKeys, LTHashAntiTampering.
 *
 * All built on `node:crypto`. Behavior (return types, error conditions, byte
 * output) verified against the WASM module in test/native-deps.mjs.
 */
import { createHash, hkdfSync } from 'node:crypto'

const u8 = b => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

/** MD5 digest, returned as Uint8Array (same as the bridge). */
export const md5 = buffer => u8(createHash('md5').update(buffer).digest())

/**
 * HKDF-SHA256 (RFC 5869).
 * @param {Uint8Array} buffer input keying material
 * @param {number} expandedLength output length in bytes (max 255 * 32)
 * @param {{ salt?: Uint8Array, info?: string }} [options] `info` is UTF-8 encoded; missing salt = zero salt
 * @returns {Uint8Array}
 */
export const hkdf = (buffer, expandedLength, { salt, info } = {}) => {
	if (expandedLength > 255 * 32) throw new Error('HKDF expansion failed')
	if (expandedLength === 0) return new Uint8Array(0) // node's hkdfSync throws on 0; the bridge returns empty
	return u8(Buffer.from(hkdfSync('sha256', buffer, salt ?? Buffer.alloc(0), Buffer.from(info ?? '', 'utf8'), expandedLength)))
}

/**
 * Derive the five WhatsApp app-state (syncd) keys from a 32-byte key.
 * Keys are Uint8Array views, in the order WhatsApp Web uses.
 */
export const expandAppStateKeys = keyData => {
	const expanded = hkdf(keyData, 160, { info: 'WhatsApp Mutation Keys' })
	const part = i => expanded.slice(i * 32, i * 32 + 32)
	return {
		indexKey: part(0),
		valueEncryptionKey: part(1),
		valueMacKey: part(2),
		snapshotMacKey: part(3),
		patchMacKey: part(4)
	}
}

/**
 * LT Hash (lattice/summation hash): each value MAC is HKDF-expanded to 128 bytes
 * and added to / subtracted from the running hash as 64 little-endian uint16 lanes.
 */
export class LTHashAntiTampering {
	constructor() {
		this.salt = 'WhatsApp Patch Integrity'
	}

	/**
	 * @param {Uint8Array} base current 128-byte hash
	 * @param {Uint8Array[]} subtract value MACs to remove
	 * @param {Uint8Array[]} add value MACs to add
	 * @returns {Uint8Array} new 128-byte hash (inputs are not mutated)
	 */
	subtractThenAdd(base, subtract, add) {
		if (base.length !== 128) throw new Error(`Base hash must be 128 bytes, got ${base.length}`)
		const lanes = new Uint16Array(64)
		const view = Buffer.from(base.buffer, base.byteOffset, base.byteLength)
		for (let i = 0; i < 64; i++) lanes[i] = view.readUInt16LE(i * 2)
		const apply = (items, sign) => {
			for (const item of items) {
				const ex = Buffer.from(hkdf(item, 128, { info: this.salt }))
				for (let i = 0; i < 64; i++) lanes[i] += sign * ex.readUInt16LE(i * 2) // Uint16Array wraps mod 2^16
			}
		}
		apply(subtract, -1)
		apply(add, +1)
		const out = Buffer.alloc(128)
		for (let i = 0; i < 64; i++) out.writeUInt16LE(lanes[i], i * 2)
		return u8(out)
	}
}
