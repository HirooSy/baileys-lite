const major = parseInt(process.versions.node.split('.')[0], 10)

if (major < 22) {
	console.error(
		`\n❌ baileys-lite requires Node.js 22+ (native WebSocket).\n` +
		`   You are using Node.js ${process.versions.node}.\n` +
		`   Please upgrade to Node.js 22+ to proceed.\n`
	)
	process.exit(1)
}
