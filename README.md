<div align=center><img src="https://files.catbox.moe/bzw1x3.png"/></div>

<p align="center">
  <a href="https://www.npmjs.com/package/@hiroosy/baileys-lite"><img height="25" alt="npm version" src="https://img.shields.io/npm/v/@hiroosy/baileys-lite?color=CB3837&style=for-the-badge&logo=npm" /></a>
  <a href="https://www.npmjs.com/package/@hiroosy/baileys-lite"><img height="25" alt="npm package size" src="https://img.shields.io/npm/unpacked-size/@hiroosy/baileys-lite?label=size&color=2F855A&style=for-the-badge&logo=npm" /></a>
  <img height="25" alt="node version" src="https://img.shields.io/badge/NodeJS_>=22-000000.svg?&style=for-the-badge&logo=node.js&logoColor=green" />
</p>

**High-Performace Javascript Baileys**, Built for high-scalability workloads, multi-session operation, and full user configurability.

- [x] Support LID/PN/Username.
- [x] High performance for multi sessions.
- [x] Native / Zero depedency.
- [x] Low memory & CPU consumption.
- [ ] Calls.

---

## Requirements

- Node.js **22 or newer** (the library uses the native global `WebSocket` and other modern built-ins).
- FFMPEG

## Install

```bash
npm install @hiroosy/baileys-lite
```


## SendMessage

<details> <summary>📖 Basic</summary>
  <sub>

```javascript
await sock.sendMessage(jid, { text: 'Hello there!' })

// quoted, mentions, ephemeral
await sock.sendMessage(jid, { text: 'Hi @6281234567890', mentions: ['6281234567890@s.whatsapp.net'] }, {
  quoted: m,
  ephemeralExpiration: 86400
})

await sock.sendMessage(jid, { react: { text: '👍', key: m.key } })

await sock.sendMessage(jid, {
  contacts: { contacts: [{ displayName: 'HirooSy', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:HirooSy\nTEL;type=CELL:+6281234567890\nEND:VCARD' }] }
})
```
</sub></details>

<details> <summary>🖼️ Media</summary>
  <sub>

```javascript
await sock.sendMessage(jid, { image: { url: './photo.jpg' }, caption: 'Nice view' })
await sock.sendMessage(jid, { video: { url: './clip.mp4' }, caption: 'Clip', gifPlayback: false })
await sock.sendMessage(jid, { audio: { url: './voice.ogg' }, ptt: true })
await sock.sendMessage(jid, { document: { url: './file.pdf' }, mimetype: 'application/pdf', fileName: 'file.pdf' })
await sock.sendMessage(jid, { sticker: { url: './sticker.webp' } })

// viewOnce (image/video/audio), video note, spoiler
await sock.sendMessage(jid, { image: { url: './photo.jpg' }, viewOnce: true })
await sock.sendMessage(jid, { video: { url: './clip.mp4' }, ptv: true })
await sock.sendMessage(jid, { image: { url: './surprise.jpg' }, caption: 'Peekaboo', spoiler: true })

// album: several media sent as one linked group
await sock.sendMessage(jid, {
  album: [
    { image: { url: './1.jpg' } },
    { image: { url: './2.jpg' } },
    { video: { url: './clip.mp4' } }
  ]
})
```
</sub></details>

<details> <summary>📍 Location</summary>
  <sub>

```javascript
await sock.sendMessage(jid, { location: { degreesLatitude: -6.2088, degreesLongitude: 106.8456, name: 'Monas' } })
```
</sub></details>

<details> <summary>🧾 Product</summary>
  <sub>

```javascript
await sock.sendMessage(jid, {
  businessOwnerJid: '1234567890@s.whatsapp.net',
  image: { url: './mouse.png' },
  product: {
    title: 'Wireless Mouse',
    description: 'Ergonomic, 2.4GHz',
    currencyCode: 'USD',
    priceAmount1000: 19990, // $19.99
    retailerId: 'sku-001'
  }
})
```
</sub></details>

<details> <summary>🛒 Carousel</summary>
  <sub>

```javascript
// card header only supports image / video / product (not location / document)
await sock.sendMessage(jid, {
  text: 'Check out our new arrivals:',
  footer: 'HirooSy',
  cards: [
    { image: { url: './item-a.jpg' }, title: 'Item A', caption: 'New in stock', nativeFlow: [{ text: 'View', id: 'view_a' }] },
    { video: { url: './item-b.mp4' }, title: 'Item B', caption: 'Limited edition', nativeFlow: [{ text: 'View', id: 'view_b' }] },
    {
      businessOwnerJid: '1234567890@s.whatsapp.net',
      product: { title: 'Wireless Mouse', productImage: { url: './mouse.png' } },
      title: 'Wireless Mouse', caption: '$19.99',
      nativeFlow: [{ text: 'Buy Now', id: 'buy_mouse' }]
    }
  ]
})
```
</sub></details>

<details> <summary>🔖 NativeFlow Button</summary>
  <sub>

```javascript
await sock.sendMessage(jid, {
  text: 'Choose one:',
  footer: 'HirooSy',
  nativeFlow: [
    { text: '👋🏻 Yes', id: 'yes_1' },
    { text: '📞 Call', call: '628123456789' },
    { text: '📋 Copy', copy: 'PROMO123' },
    { text: '🌐 Source', url: 'https://example.com' },
    {
      text: '📋 Select',
      sections: [{ title: '✨ Section 1', rows: [{ title: '🏷️ Coupon', id: 'coupon_code' }] }]
    }
  ]
})

// with a media header — use caption instead of text, plus image / video / document / location / product
await sock.sendMessage(jid, {
  image: { url: './promo.jpg' },
  title: 'Flash Sale',
  caption: 'Up to 50% off today only',
  footer: 'HirooSy',
  nativeFlow: [
    { text: 'Shop Now', url: 'https://shop.example.com' },
    { text: 'Copy Code', copy: 'SALE50' }
  ]
})
```
</sub></details>

<details> <summary>🔘 Legacy Button</summary>
  <sub>

```javascript
// pre-native-flow format — prefer nativeFlow above for new bots
await sock.sendMessage(jid, {
  text: 'Choose one:',
  footer: 'HirooSy',
  templateButtons: [
    { text: 'Reply', id: 'r1' },
    { text: 'Visit', url: 'https://example.com' },
    { text: 'Call', call: '+6281234567890' }
  ]
})
```
</sub></details>

<details> <summary>↩️ Button/List Replies</summary>
  <sub>

```javascript
// simulate/relay a user's tap — mainly for bot-to-bot or automated-response flows
await sock.sendMessage(jid, { buttonReply: { id: 'yes_1', displayText: 'Yes' }, type: 'plain' })
await sock.sendMessage(jid, { listReply: { id: 'row1', title: 'Row 1', description: 'desc' } })
await sock.sendMessage(jid, { flowReply: { name: 'single_select', paramsJson: JSON.stringify({ id: 'row1' }) } })
```
</sub></details>

<details> <summary>📊 Poll</summary>
  <sub>

```javascript
await sock.sendMessage(jid, {
  poll: { name: 'Favorite language?', values: ['JavaScript', 'Python', 'Rust'], selectableCount: 1 }
})

// quiz polls are newsletter-only and require correctAnswer
await sock.sendMessage(newsletterJid, {
  poll: { name: 'Capital of Japan?', values: ['Tokyo', 'Osaka'], pollType: 1, correctAnswer: 'Tokyo' }
})

// final tally snapshot for a poll you created
await sock.sendMessage(jid, {
  pollResult: { name: 'Favorite language?', votes: [{ name: 'JavaScript', voteCount: 12 }, { name: 'Python', voteCount: 9 }] }
})
```
</sub></details>

<details> <summary>🗓️ AI Rich</summary>
  <sub>

```javascript
await sock.aiRich()
    .setTitle('Ai Rich Message')
    .addText('[HyperLink](https://example.com)\nCitation [](https://example.com)')
    .addImage('https://example.com/image.png')
    .addCode('javascript', `console.log('Hello World')`)
    .addHtml(['<html>Hello world</html>', 'Tab 1'], ['<html>Hi twin</html>', 'Tab 2'])
    .addTable([
        ['Name', 'HirooSy'],
        ['Bio', 'Im developer'],
        ['Age', '67']
    ])
    .addSource([['https://example.com/favicon.ico', 'https://example.com', 'Source']])
    .addTip('Tip Text')
    .addSuggest(['Continue', 'Cancel'])
    .send(jid, { quoted: m })

// animated progress
await sock.aiRich()
  .addProcess('Loading...')
  .send(jid)

// plain-spec shorthand, no builder chain
await sock.sendMessage(jid, {
  aiRich: { title: 'Assistant', text: 'Here is what I found:', table: [['Name', 'Score'], ['Alice', '90']] }
})
```

<details> <summary><sub>All AiRich Methods</sub></summary>

| Method | Purpose |
| --- | --- |
| `setTitle(title)` | Disclaimer label shown on the message |
| `setFooter(footer)` | Trailing metadata text block |
| `setContextInfo(obj)` | Merges extra fields into `contextInfo` |
| `addText(text, opts?)` | Markdown text; auto-extracts `[text](url)` links, `[](url)` citations, `[text\|w\|h](<url>)` LaTeX |
| `addCode(language, code)` | Syntax-highlighted code block |
| `addTable(rows, opts?)` | `[[header...], [row...], ...]` array of strings |
| `addImage(image)` | `string \| Buffer \| array` — image grid |
| `addVideo(video)` | `string \| Buffer \| { url, mimeType?, duration? } \| array` |
| `addSource(sources)` | `[icon, url, text][]` — source/citation cards |
| `addProduct(data)` | Product card(s) — object or array for a carousel |
| `addPost(data)` | Social-post card(s) — object or array for a carousel |
| `addReels(data)` | Reel card(s) — object or array |
| `addTip(text)` | Small metadata/tip text line |
| `addSuggest(suggestion, opts?)` | Follow-up suggestion pill(s) |
| `addProcess(title)` | In-progress status indicator |
| `addHtml(...)` | One inline HTML block, or `[html, title]` tab pairs |
| `build(opts?)` | Assemble the raw content without sending |
| `send(jid, opts?)` | Shorthand for `sendMessage(jid, { aiRich: this, ...opts })` |

</details>
</sub></details>

<details> <summary>📦 Sticker</summary>
  <sub>

```javascript
// single sticker
await sock.sendMessage(jid, { sticker: { url: './sticker.webp' } })

// sticker pack — needs `sharp` or `@napi-rs/image` installed, max 60, requires a cover
await sock.sendMessage(jid, {
  stickers: [{ data: { url: './s1.webp' } }, { data: { url: './s2.webp' } }],
  cover: { url: './cover.webp' },
  name: 'My Sticker Pack',
  publisher: 'HirooSy'
})
```
</sub></details>

<details> <summary>✏️ Message Actions</summary>
  <sub>

```javascript
await sock.sendMessage(jid, { pin: m.key, type: 1, time: 86400 })   // type: 0 unpin, 1 pin
await sock.sendMessage(jid, { keep: m.key, type: 1 })               // type: 0 remove, 1 keep
await sock.sendMessage(jid, { text: 'Updated text', edit: m.key })
await sock.sendMessage(jid, { delete: m.key })

// group only — toggle disappearing messages
await sock.sendMessage(groupJid, { disappearingMessagesInChat: true })    // 7 days
await sock.sendMessage(groupJid, { disappearingMessagesInChat: 86400 })   // custom seconds
await sock.sendMessage(groupJid, { disappearingMessagesInChat: false })   // off
```
</sub></details>

<details> <summary>🗓️ Event</summary>
  <sub>

```javascript
await sock.sendMessage(jid, {
  event: { name: 'Team Sync', description: 'Discuss the Q1 roadmap', startDate: new Date(Date.now() + 3600_000) }
})
```
</sub></details>

<details> <summary>💳 Payments & Business</summary>
  <sub>

```javascript
await sock.sendMessage(jid, { requestPaymentFrom: recipientJid, text: 'Payment for order #123' })
await sock.sendMessage(jid, { paymentInviteServiceType: 1 })
await sock.sendMessage(jid, { orderText: 'Your order summary', thumbnail: fs.readFileSync('./order-thumb.jpg') })
await sock.sendMessage(jid, { document: { url: './invoice.pdf' }, mimetype: 'application/pdf', invoiceNote: 'Invoice #1024' })

// sponsored ad card attached to any message
await sock.sendMessage(jid, {
  text: 'Check this deal!',
  externalAdReply: { title: 'Big Sale', body: '50% off', thumbnail: fs.readFileSync('./thumb.jpg'), mediaType: 1, url: 'https://example.com' }
})

await sock.sendMessage(jid, { requestPhoneNumber: true })
await sock.sendMessage(jid, { sharePhoneNumber: true })

await sock.sendMessage(jid, {
  groupInvite: { jid: groupJid, inviteCode: code, inviteExpiration: Date.now() + 3600_000, subject: 'My Group', text: 'Join us!' }
})

// disable further forwarding of a message
await sock.sendMessage(jid, { limitSharing: true })
```
</sub></details>

<details> <summary>📤 Status</summary>
  <sub>

```javascript
// jid can be an array to control exactly who sees a status with mentions
await sock.sendMessage([contactJid1, contactJid2], { text: 'Status update text' })
```
</sub></details>