<div align=center><img src="https://files.catbox.moe/bzw1x3.png"/></div>

<p align="center">
  <a href="https://www.npmjs.com/package/@hiroosy/baileys-lite"><img height="25" alt="npm version" src="https://img.shields.io/npm/v/@hiroosy/baileys?color=CB3837&style=for-the-badge&logo=npm" /></a>
  <a href="https://www.npmjs.com/package/@hiroosy/baileys-lite"><img height="25" alt="npm package size" src="https://img.shields.io/npm/unpacked-size/@hiroosy/baileys?label=size&color=2F855A&style=for-the-badge&logo=npm" /></a>
  <img height="25" alt="node version" src="https://img.shields.io/badge/NodeJS_22+-000000.svg?&style=for-the-badge&logo=node.js&logoColor=green" />
</p>

A lightweight, dependency-free recode of [Baileys](https://github.com/WhiskeySockets/Baileys) — the
WhatsApp Web API library. Same public API and event model as upstream Baileys, rebuilt on Node.js
built-ins instead of third-party packages.

## Requirements

- Node.js **22 or newer** (the library uses the native global `WebSocket` and other modern built-ins).
- FFMPEG

## Install

```bash
npm install @hiroosy/baileys
```

> [!IMPORTANT]
> This library is **ESM-only** (`"type": "module"`). Use `import`, not `require`.# baileys-lite
