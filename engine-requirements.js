const major = parseInt(process.versions.node.split('.')[0], 10)

// baileys-lite uses the native global WebSocket (stable in Node 22+) instead of `ws`.
if (major < 22) {
	console.error(
		`\n❌ baileys-lite requires Node.js 22+ (native WebSocket).\n` +
		`   You are using Node.js ${process.versions.node}.\n` +
		`   Please upgrade to Node.js 22+ to proceed.\n`
	)
	process.exit(1)
}
