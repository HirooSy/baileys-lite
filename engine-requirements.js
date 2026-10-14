const major = parseInt(process.versions.node.split('.')[0], 10)

if (major < 18) {
	console.error(
		`\n❌ baileys-lite requires Node.js 18+.\n` +
		`   You are using Node.js ${process.versions.node}.\n` +
		`   Please upgrade to Node.js 18+ to proceed.\n`
	)
	process.exit(1)
}
