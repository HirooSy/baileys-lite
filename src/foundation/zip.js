import { deflateRawSync, crc32 } from 'node:zlib'

function dosDateTime(date = new Date()) {
	const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
	const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
	return { dosTime, dosDate }
}

function crc32Of(buf) {

	if (typeof crc32 === 'function') return crc32(buf) >>> 0
	return crc32Fallback(buf)
}

let CRC_TABLE
function crc32Fallback(buf) {
	if (!CRC_TABLE) {
		CRC_TABLE = new Uint32Array(256)
		for (let n = 0; n < 256; n++) {
			let c = n
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
			CRC_TABLE[n] = c >>> 0
		}
	}
	let crc = 0xffffffff
	for (let i = 0; i < buf.length; i++) {
		crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0
}

export function zip(files, callback) {
	try {
		const localChunks = []
		const centralChunks = []
		let offset = 0
		const { dosTime, dosDate } = dosDateTime()

		for (const filename of Object.keys(files)) {
			const [rawData, opts = {}] = files[filename]
			const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData)
			const level = opts.level ?? 6
			const store = level === 0
			const compressed = store ? data : deflateRawSync(data, { level })
			const method = store ? 0 : 8
			const crc = crc32Of(data)
			const nameBuf = Buffer.from(filename, 'utf8')

			const localHeader = Buffer.alloc(30)
			localHeader.writeUInt32LE(0x04034b50, 0)
			localHeader.writeUInt16LE(20, 4)
			localHeader.writeUInt16LE(0, 6)
			localHeader.writeUInt16LE(method, 8)
			localHeader.writeUInt16LE(dosTime, 10)
			localHeader.writeUInt16LE(dosDate, 12)
			localHeader.writeUInt32LE(crc, 14)
			localHeader.writeUInt32LE(compressed.length, 18)
			localHeader.writeUInt32LE(data.length, 22)
			localHeader.writeUInt16LE(nameBuf.length, 26)
			localHeader.writeUInt16LE(0, 28)

			localChunks.push(localHeader, nameBuf, compressed)

			const centralHeader = Buffer.alloc(46)
			centralHeader.writeUInt32LE(0x02014b50, 0)
			centralHeader.writeUInt16LE(20, 4)
			centralHeader.writeUInt16LE(20, 6)
			centralHeader.writeUInt16LE(0, 8)
			centralHeader.writeUInt16LE(method, 10)
			centralHeader.writeUInt16LE(dosTime, 12)
			centralHeader.writeUInt16LE(dosDate, 14)
			centralHeader.writeUInt32LE(crc, 16)
			centralHeader.writeUInt32LE(compressed.length, 20)
			centralHeader.writeUInt32LE(data.length, 24)
			centralHeader.writeUInt16LE(nameBuf.length, 28)
			centralHeader.writeUInt16LE(0, 30)
			centralHeader.writeUInt16LE(0, 32)
			centralHeader.writeUInt16LE(0, 34)
			centralHeader.writeUInt16LE(0, 36)
			centralHeader.writeUInt32LE(0, 38)
			centralHeader.writeUInt32LE(offset, 42)

			centralChunks.push(centralHeader, nameBuf)

			offset += localHeader.length + nameBuf.length + compressed.length
		}

		const centralDirSize = centralChunks.reduce((sum, c) => sum + c.length, 0)
		const centralDirOffset = offset
		const fileCount = Object.keys(files).length

		const eocd = Buffer.alloc(22)
		eocd.writeUInt32LE(0x06054b50, 0)
		eocd.writeUInt16LE(0, 4)
		eocd.writeUInt16LE(0, 6)
		eocd.writeUInt16LE(fileCount, 8)
		eocd.writeUInt16LE(fileCount, 10)
		eocd.writeUInt32LE(centralDirSize, 12)
		eocd.writeUInt32LE(centralDirOffset, 16)
		eocd.writeUInt16LE(0, 20)

		const result = Buffer.concat([...localChunks, ...centralChunks, eocd])
		callback(null, result)
	} catch (err) {
		callback(err)
	}
}
