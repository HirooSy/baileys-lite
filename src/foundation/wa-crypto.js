import { createHash, hkdfSync } from 'node:crypto'

const u8 = b => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

export const md5 = buffer => u8(createHash('md5').update(buffer).digest())

export const hkdf = (buffer, expandedLength, { salt, info } = {}) => {
	if (expandedLength > 255 * 32) throw new Error('HKDF expansion failed')
	if (expandedLength === 0) return new Uint8Array(0)
	return u8(Buffer.from(hkdfSync('sha256', buffer, salt ?? Buffer.alloc(0), Buffer.from(info ?? '', 'utf8'), expandedLength)))
}

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

export class LTHashAntiTampering {
	constructor() {
		this.salt = 'WhatsApp Patch Integrity'
	}

	subtractThenAdd(base, subtract, add) {
		if (base.length !== 128) throw new Error(`Base hash must be 128 bytes, got ${base.length}`)
		const lanes = new Uint16Array(64)
		const view = Buffer.from(base.buffer, base.byteOffset, base.byteLength)
		for (let i = 0; i < 64; i++) lanes[i] = view.readUInt16LE(i * 2)
		const apply = (items, sign) => {
			for (const item of items) {
				const ex = Buffer.from(hkdf(item, 128, { info: this.salt }))
				for (let i = 0; i < 64; i++) lanes[i] += sign * ex.readUInt16LE(i * 2)
			}
		}
		apply(subtract, -1)
		apply(add, +1)
		const out = Buffer.alloc(128)
		for (let i = 0; i < 64; i++) out.writeUInt16LE(lanes[i], i * 2)
		return u8(out)
	}
}
