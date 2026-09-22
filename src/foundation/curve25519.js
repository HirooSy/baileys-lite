/**
 * Native Curve25519 / XEdDSA (Signal-style signatures with X25519 keys).
 *
 * Replaces `curve25519-js` (used indirectly through `libsignal/src/curve.js`).
 * - Key agreement + X25519 keygen use `node:crypto` (native OpenSSL).
 * - XEdDSA sign / verify use BigInt arithmetic over the Ed25519 curve, because
 *   Node's Ed25519 API cannot sign with a raw (already-clamped) scalar.
 *
 * Signatures are byte-for-byte identical to `curve25519-js` (deterministic
 * variant, i.e. without the optional 64-byte random suffix) — verified by
 * test/native-deps.mjs against the original package.
 */
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from 'node:crypto'

const P = (1n << 255n) - 19n
const L = (1n << 252n) + 27742317777372353535851937790883648493n
// d = -121665/121666 mod p
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n
const BASE_Y = 46316835694926478169428394003475163141307993866256225615783033603165251855960n
const BASE_X = 15112221349535400772501151409588531511454012693041857206046113283949847762202n

const mod = (a, m = P) => {
	const r = a % m
	return r >= 0n ? r : r + m
}
const pow = (b, e, m = P) => {
	let r = 1n
	b = mod(b, m)
	while (e > 0n) {
		if (e & 1n) r = (r * b) % m
		b = (b * b) % m
		e >>= 1n
	}
	return r
}
const inv = a => pow(a, P - 2n)

/* ---- byte <-> bigint (little endian) ---- */
const bytesToNumLE = b => {
	let n = 0n
	for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
	return n
}
const numToBytesLE = (n, len) => {
	const out = Buffer.alloc(len)
	for (let i = 0; i < len; i++) {
		out[i] = Number(n & 0xffn)
		n >>= 8n
	}
	return out
}

/* ---- Edwards curve, extended coordinates (X, Y, Z, T) ---- */
const ZERO = [0n, 1n, 1n, 0n]
const BASE = [BASE_X, BASE_Y, 1n, mod(BASE_X * BASE_Y)]

const pointAdd = (p, q) => {
	const [X1, Y1, Z1, T1] = p
	const [X2, Y2, Z2, T2] = q
	const A = mod((Y1 - X1) * (Y2 - X2))
	const B = mod((Y1 + X1) * (Y2 + X2))
	const C = mod(2n * D * T1 * T2)
	const Dd = mod(2n * Z1 * Z2)
	const E = B - A
	const F = Dd - C
	const G = Dd + C
	const H = B + A
	return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)]
}

const scalarMult = (point, scalar) => {
	let r = ZERO
	let q = point
	while (scalar > 0n) {
		if (scalar & 1n) r = pointAdd(r, q)
		q = pointAdd(q, q)
		scalar >>= 1n
	}
	return r
}

const encodePoint = p => {
	const zi = inv(p[2])
	const x = mod(p[0] * zi)
	const y = mod(p[1] * zi)
	const out = numToBytesLE(y, 32)
	if (x & 1n) out[31] |= 0x80
	return out
}

/** Decode an Edwards point; returns null if it is not on the curve. */
const decodePoint = bytes => {
	const b = Buffer.from(bytes)
	const sign = (b[31] & 0x80) >> 7
	b[31] &= 0x7f
	const y = bytesToNumLE(b)
	if (y >= P) return null
	const y2 = mod(y * y)
	const u = mod(y2 - 1n)
	const v = mod(D * y2 + 1n)
	// x = sqrt(u/v)
	const v3 = mod(v * v * v)
	const v7 = mod(v3 * v3 * v)
	let x = mod(u * v3 * pow(mod(u * v7), (P - 5n) / 8n))
	const vx2 = mod(v * x * x)
	if (vx2 !== mod(u)) {
		if (vx2 !== mod(-u)) return null
		x = mod(x * SQRT_M1)
	}
	if (Number(x & 1n) !== sign) x = mod(-x)
	return [x, y, 1n, mod(x * y)]
}

const sha512 = (...parts) => {
	const h = createHash('sha512')
	for (const p of parts) h.update(p)
	return h.digest()
}

const clamp = key => {
	const k = Buffer.from(key)
	k[0] &= 248
	k[31] &= 127
	k[31] |= 64
	return k
}

/* ---- DER prefixes for raw X25519 keys (Node crypto) ---- */
const PUB_DER = Buffer.from('302a300506032b656e032100', 'hex')
const PRIV_DER = Buffer.from('302e020100300506032b656e04220420', 'hex')

/** X25519 shared secret. `pub` = 32 raw bytes, `priv` = 32 raw bytes. */
export const sharedKey = (priv, pub) =>
	diffieHellman({
		privateKey: createPrivateKey({ key: Buffer.concat([PRIV_DER, priv]), format: 'der', type: 'pkcs8' }),
		publicKey: createPublicKey({ key: Buffer.concat([PUB_DER, pub]), format: 'der', type: 'spki' })
	})

/** Random X25519 key pair (32-byte raw keys). */
export const randomX25519 = () => {
	const { publicKey, privateKey } = generateKeyPairSync('x25519', {
		publicKeyEncoding: { format: 'der', type: 'spki' },
		privateKeyEncoding: { format: 'der', type: 'pkcs8' }
	})
	return {
		pub: publicKey.subarray(PUB_DER.length, PUB_DER.length + 32),
		priv: privateKey.subarray(PRIV_DER.length, PRIV_DER.length + 32)
	}
}

/**
 * Public key for a given (possibly unclamped) 32-byte private key, exactly like
 * curve25519-js `generateKeyPair(seed).public`: X25519(base point) with the
 * top bit cleared.
 */
export const publicFromPrivate = seed => {
	if (seed.length !== 32) throw new Error('wrong seed length')
	const priv = Buffer.from(seed)
	// X25519 clamps internally; Node's diffieHellman against the base point (u=9) gives the public key
	const base = Buffer.alloc(32)
	base[0] = 9
	const pub = Buffer.from(sharedKey(priv, base))
	pub[31] &= 0x7f
	return pub
}

/** Curve25519 (Montgomery u) -> Ed25519 (Edwards y): y = (u - 1) / (u + 1) */
const montToEdY = pk => {
	const b = Buffer.from(pk)
	b[31] &= 0x7f // curve25519-js unpack25519 ignores the top bit
	const u = mod(bytesToNumLE(b))
	const y = mod((u - 1n) * inv(mod(u + 1n)))
	return numToBytesLE(y, 32)
}

/**
 * XEdDSA sign (deterministic variant). Equivalent to curve25519-js `sign(sk, msg)`.
 * @returns {Buffer} 64-byte signature
 */
export const sign = (secretKey, msg) => {
	if (secretKey.length !== 32) throw new Error('wrong secret key length')
	const a = clamp(secretKey)
	const aNum = bytesToNumLE(a)
	const A = encodePoint(scalarMult(BASE, aNum))
	const signBit = A[31] & 0x80
	// r = H(a || m) mod L  (curve25519-js hashes the clamped secret directly)
	const r = mod(bytesToNumLE(sha512(a, msg)), L)
	const R = encodePoint(scalarMult(BASE, r))
	const Acompressed = Buffer.from(A)
	// h = H(R || A || m) mod L — A here is the packed public key WITH its sign bit
	const h = mod(bytesToNumLE(sha512(R, Acompressed, msg)), L)
	const S = mod(r + h * aNum, L)
	const sig = Buffer.concat([R, numToBytesLE(S, 32)])
	sig[63] |= signBit
	return sig
}

/**
 * XEdDSA verify. Equivalent to curve25519-js `verify(pk, msg, sig)`.
 * @returns {boolean}
 */
export const verify = (publicKey, msg, signature) => {
	if (signature.length !== 64) throw new Error('wrong signature length')
	if (publicKey.length !== 32) throw new Error('wrong public key length')
	const sig = Buffer.from(signature)
	const edpk = montToEdY(publicKey)
	edpk[31] |= sig[63] & 0x80
	sig[63] &= 0x7f
	const A = decodePoint(edpk)
	if (!A) return false
	const R = sig.subarray(0, 32)
	const S = bytesToNumLE(sig.subarray(32))
	const h = mod(bytesToNumLE(sha512(R, edpk, msg)), L)
	// check: S*B == R + h*A   <=>   S*B - h*A == R  (compare encodings, like the reference)
	const negA = [mod(-A[0]), A[1], A[2], mod(-A[3])]
	const check = pointAdd(scalarMult(negA, h), scalarMult(BASE, S))
	return Buffer.compare(encodePoint(check), R) === 0
}

export { randomBytes }
