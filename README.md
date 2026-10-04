<div align=center><img src="https://files.catbox.moe/bzw1x3.png"/></div>

<p align="center">
  <a href="https://www.npmjs.com/package/@hiroosy/baileys-lite"><img height="25" alt="npm version" src="https://img.shields.io/npm/v/@hiroosy/baileys-lite?color=CB3837&style=for-the-badge&logo=npm" /></a>
  <a href="https://www.npmjs.com/package/@hiroosy/baileys-lite"><img height="25" alt="npm package size" src="https://img.shields.io/npm/unpacked-size/@hiroosy/baileys-lite?label=size&color=2F855A&style=for-the-badge&logo=npm" /></a>
  <img height="25" alt="node version" src="https://img.shields.io/badge/NodeJS_>=22-000000.svg?&style=for-the-badge&logo=node.js&logoColor=green" />
</p>

**High-Performance Javascript Baileys**, built for high-scalability workloads, multi-session operation, and full user configurability.

- [x] Support LID/PN/Username.
- [x] High performance for multi sessions.
- [x] Zero dependency.
- [x] Low memory & CPU consumption.
- [x] Calls: Video & Audio.

---

## Install

Needs **Node.js 22+** and FFmpeg. Calls also need `ffprobe` in `PATH`. No native or WebRTC dependencies are required.

```bash
npm install @hiroosy/baileys-lite
```

## Quick Start

```javascript
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  extractMessageContent
} from '@hiroosy/baileys-lite'

const PHONE_NUMBER = '' // '628123456789' = pairing code
const PAIR_CODE = ''    // optional custom 8-char code

const start = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./session')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !PHONE_NUMBER,
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  let pairingRequested = false
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && PHONE_NUMBER && !pairingRequested) {
      pairingRequested = true
      try {
        console.log('Pairing code:', await sock.requestPairingCode(PHONE_NUMBER, PAIR_CODE || undefined))
      } catch (err) {
        console.error('Could not request a pairing code:', err.message)
      }
    }

    if (connection === 'open') console.log('Connected as', sock.user?.id)

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        return console.log('Logged out. Delete ./session and run again to link a new device.')
      }
      if (code === DisconnectReason.connectionReplaced) {
        return console.log('This session was opened somewhere else. Not reconnecting.')
      }
      console.log(`Connection closed (${code}), reconnecting...`)
      setTimeout(start, 1000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      if (m.key.fromMe || !m.message) continue
      const content = extractMessageContent(m.message)
      const text = content?.conversation || content?.extendedTextMessage?.text
      if (text === '!ping') {
        await sock.sendMessage(m.key.remoteJid, { text: 'pong' }, { quoted: m }).catch(console.error)
      }
    }
  })
}

start()
```

- **QR:** leave `PHONE_NUMBER` empty and scan it from *Linked devices* → *Link a device*.
- **Pairing code:** set `PHONE_NUMBER`, choose *Link with phone number instead*, type the code.
- **Custom pairing code:** set `PAIR_CODE` to any 8 characters. Empty gives a random one.

Send `!ping` from another number and the bot answers `pong`. The login is saved in `./session`, so keep it private and out of git.

<details> <summary>Common options</summary>

| Option | Default | Notes |
|---|---|---|
| `auth` | – | Required. `state` from an auth helper. |
| `browser` | `Browsers.macOS('Chrome')` | Device name in *Linked devices*. Also `Browsers.ubuntu()`, `.windows()`, `.appropriate()`. |
| `printQRInTerminal` | `false` | Print every QR in the terminal. `qr` is always emitted in `connection.update`. |
| `qrTimeout` | `60000`, then `20000` | How long each QR stays valid. |
| `syncFullHistory` | `true` | `false` is lighter for bots. |
| `markOnlineOnConnect` | `true` | `false` keeps notifications on your phone. |
| `connectTimeoutMs` | `20000` | Timeout of the opening handshake. |
| `keepAliveIntervalMs` | `30000` | Ping interval. |
| `defaultQueryTimeoutMs` | `60000` | Timeout of a server request. |
| `getMessage` | returns `undefined` | Return the stored message for a key so retries and poll votes can be decrypted. |
| `disableStickyRouting` | `false` | `true` stops sending `ED` in the URL and the `sticky_routing` cookie. |
| `waWebSocketUrl` | `wss://web.whatsapp.com/ws/chat` | Custom endpoint only. |
| `logger` | built-in | A pino-style logger. |

</details>

<details> <summary>Session Type Choices </summary>

All helpers return `{ state, saveCreds }`, so they are interchangeable.

```javascript
import { useMultiFileAuthState, useSingleFileAuthState, useSqliteAuthState } from '@hiroosy/baileys-lite'

const a = await useMultiFileAuthState('./session')             // one file per key
const b = await useSingleFileAuthState('./session.json')       // one file, flushed in batches
const c = await useSqliteAuthState({ dbPath: './session.db' }) // SQLite, best for many sessions
```

</details>

<details> <summary>Disconnect Status</summary>

`lastDisconnect.error.output.statusCode` matches `DisconnectReason`:

| Code | `DisconnectReason` | Meaning |
|---|---|---|
| `401` | `loggedOut` | Device removed or session invalid. Delete the session and link again. |
| `440` | `connectionReplaced` | Opened somewhere else. Do not reconnect. |
| `515` | `restartRequired` | Normal after pairing. Reconnect. |
| `428` / `408` | `connectionClosed` / `connectionLost` / `timedOut` | Network drop. Reconnect. |
| `500` | `badSession` | Server rejected the stream. Reconnect. |

When the server closes the socket, `lastDisconnect.error.data` has `wsCode` and `wsReason`.

</details>

---

## SendMessage

<details> <summary>Basic</summary>

```javascript
await sock.sendMessage(jid, { text: 'Hello there!' })

await sock.sendMessage(jid, { text: 'Hi @6281234567890', mentions: ['6281234567890@s.whatsapp.net'] }, {
  quoted: m,
  ephemeralExpiration: 86400
})

await sock.sendMessage(jid, { react: { text: '👍', key: m.key } })

await sock.sendMessage(jid, {
  contacts: { contacts: [{ displayName: 'HirooSy', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:HirooSy\nTEL;type=CELL:+6281234567890\nEND:VCARD' }] }
})
```

</details>

<details> <summary>Media</summary>

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

// album
await sock.sendMessage(jid, {
  album: [
    { image: { url: './1.jpg' } },
    { image: { url: './2.jpg' } },
    { video: { url: './clip.mp4' } }
  ]
})
```

</details>

<details> <summary>Location</summary>

```javascript
await sock.sendMessage(jid, { location: { degreesLatitude: -6.2088, degreesLongitude: 106.8456, name: 'Monas' } })
```

</details>

<details> <summary>Product</summary>

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

</details>

<details> <summary>Carousel</summary>

```javascript
// card header: image, video or product only
await sock.sendMessage(jid, {
  text: 'Check out our new arrivals:',
  footer: 'HirooSy',
  cards: [
    { image: { url: './item-a.jpg' }, title: 'Item A', caption: 'New in stock', nativeFlow: [{ text: 'View', id: 'view_a' }] },
    { video: { url: './item-b.mp4' }, title: 'Item B', caption: 'Limited edition', nativeFlow: [{ text: 'View', id: 'view_b' }] },
    {
      businessOwnerJid: '1234567890@s.whatsapp.net',
      product: { title: 'Wireless Mouse', productImage: { url: './mouse.png' } },
      title: 'Wireless Mouse',
      caption: '$19.99',
      nativeFlow: [{ text: 'Buy Now', id: 'buy_mouse' }]
    }
  ]
})
```

</details>

<details> <summary>NativeFlow Button</summary>

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

// media header: use caption instead of text (image, video, document, location, product)
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

// widget (A2UI): can be combined with buttons, or use nativeFlow: [] for none
await sock.sendMessage(jid, {
  text: 'Widget demo',
  footer: 'A2UI Showcase',
  nativeFlow: [{ text: '🌐 Source', url: 'https://example.com' }],
  widget: {
    align: 'center',
    fallback: 'Widget cannot be loaded on this device', // optional
    items: [
      { text: 'Welcome to the Widget Demo', variant: 'title' }, // title | body | caption
      { text: 'This is a longer description.', variant: 'body' },

      { icon: 'info' },
      { icon: 'warning', style: 'symbol' },
      { icon: 'favorite', native: true },

      { image: 'https://example.com/banner.jpg', variant: 'header', fit: 'cover', description: 'Promo banner' },
      { video: 'https://example.com/preview.mp4' },
      { audio: 'https://example.com/audio.mp3', description: 'Listen to this audio' },

      { divider: 'horizontal' }, // or 'vertical'
      { button: 'Open Website', url: 'https://example.com', variant: 'primary' },

      { input: 'name', label: 'Enter your name', value: '', variant: 'shortText' }, // or 'longText'
      { input: 'email', label: 'Email', validationRegexp: '^[^@]+@[^@]+\\.[^@]+$' },
      { checkbox: 'I agree to the terms & conditions', value: false },
      { choice: ['Red', 'Green', 'Blue'], label: 'Favorite color', variant: 'mutuallyExclusive', displayStyle: 'chips', filterable: true },
      { choice: [{ label: 'Option A', value: 'a' }, { label: 'Option B', value: 'b' }], label: 'Multi-select', variant: 'multipleSelection', value: ['a'] },
      { slider: 100, min: 0, value: 50, label: 'Volume' }, // slider = max value
      { datetime: true, label: 'Pick a date', enableDate: true, enableTime: false },

      { row: [{ text: 'Left' }, { text: 'Center' }, { text: 'Right' }], justify: 'space-between', align: 'center' },
      { column: [{ text: 'Row 1' }, { text: 'Row 2' }], justify: 'start', align: 'stretch' },
      { list: [{ text: '• First item' }, { text: '• Second item' }], direction: 'vertical' }
    ]
  }
})
```

</details>

<details> <summary>Legacy Button</summary>

```javascript
// old format, prefer nativeFlow
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

</details>

<details> <summary>Button/List Replies</summary>

```javascript
// send a reply as if a user tapped a button
await sock.sendMessage(jid, { buttonReply: { id: 'yes_1', displayText: 'Yes' }, type: 'plain' })
await sock.sendMessage(jid, { listReply: { id: 'row1', title: 'Row 1', description: 'desc' } })
await sock.sendMessage(jid, { flowReply: { name: 'single_select', paramsJson: JSON.stringify({ id: 'row1' }) } })
```

</details>

<details> <summary>Poll</summary>

```javascript
await sock.sendMessage(jid, {
  poll: { name: 'Favorite language?', values: ['JavaScript', 'Python', 'Rust'], selectableCount: 1 }
})

// quiz polls: newsletter only, need correctAnswer
await sock.sendMessage(newsletterJid, {
  poll: { name: 'Capital of Japan?', values: ['Tokyo', 'Osaka'], pollType: 1, correctAnswer: 'Tokyo' }
})

// final tally of a poll you created
await sock.sendMessage(jid, {
  pollResult: { name: 'Favorite language?', votes: [{ name: 'JavaScript', voteCount: 12 }, { name: 'Python', voteCount: 9 }] }
})
```

</details>

<details> <summary>AI Rich</summary>

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

// shorthand without the builder
await sock.sendMessage(jid, {
  aiRich: { title: 'Assistant', text: 'Here is what I found:', table: [['Name', 'Score'], ['Alice', '90']] }
})

// bypass download is on by default, turn it off per message
await sock.aiRich()
  .addText('No bypass')
  .send(jid, { bypassDownload: false })
```

**Bypass download:** `send()` edits its own message right after sending, so the client renders the rich response without having to download it first. It only runs for messages that carry a rich response. If the edit fails, the error is thrown with `error.relayedKey` set to the key of the message that was already sent.

<details> <summary align=center>All AiRich Methods</summary>

| Method | Purpose |
| --- | --- |
| `setTitle(title)` | Disclaimer label shown on the message |
| `setFooter(footer)` | Trailing metadata text block |
| `setContextInfo(obj)` | Merges extra fields into `contextInfo` |
| `addText(text, opts?)` | Markdown text. Extracts `[text](url)` links, `[](url)` citations, `[text\|w\|h](<url>)` LaTeX |
| `addCode(language, code)` | Syntax-highlighted code block |
| `addTable(rows, opts?)` | `[[header...], [row...], ...]` array of strings |
| `addImage(image)` | `string \| Buffer \| array`, shown as a grid |
| `addVideo(video)` | `string \| Buffer \| { url, mimeType?, duration? } \| array` |
| `addSource(sources)` | `[icon, url, text][]` source cards |
| `addProduct(data)` | Product card, or an array for a carousel |
| `addPost(data)` | Social-post card, or an array for a carousel |
| `addReels(data)` | Reel card, or an array |
| `addTip(text)` | Small tip line |
| `addSuggest(suggestion, opts?)` | Follow-up suggestion pill |
| `addProcess(title)` | In-progress status indicator |
| `addHtml(...)` | One inline HTML block, or `[html, title]` tab pairs |
| `build(opts?)` | Build the raw content without sending |
| `buildEdit(jid, key, message)` | Builds the edit payload used by bypass download |
| `send(jid, opts?)` | Sends the message. `opts.bypassDownload` (default `true`) sends the follow-up edit. Other options go to `sendMessage` |

</details>

</details>

<details> <summary>Sticker</summary>

```javascript
await sock.sendMessage(jid, { sticker: { url: './sticker.webp' } })

// sticker pack: needs sharp or @napi-rs/image, max 60, cover required
await sock.sendMessage(jid, {
  stickers: [{ data: { url: './s1.webp' } }, { data: { url: './s2.webp' } }],
  cover: { url: './cover.webp' },
  name: 'My Sticker Pack',
  publisher: 'HirooSy'
})
```

</details>

<details> <summary>Message Actions</summary>

```javascript
await sock.sendMessage(jid, { pin: m.key, type: 1, time: 86400 }) // type: 0 unpin, 1 pin
await sock.sendMessage(jid, { keep: m.key, type: 1 })             // type: 0 remove, 1 keep
await sock.sendMessage(jid, { text: 'Updated text', edit: m.key })
await sock.sendMessage(jid, { delete: m.key })

// group only: disappearing messages
await sock.sendMessage(groupJid, { disappearingMessagesInChat: true })   // 7 days
await sock.sendMessage(groupJid, { disappearingMessagesInChat: 86400 })  // custom seconds
await sock.sendMessage(groupJid, { disappearingMessagesInChat: false })  // off
```

</details>

<details> <summary>Event</summary>

```javascript
await sock.sendMessage(jid, {
  event: { name: 'Team Sync', description: 'Discuss the Q1 roadmap', startDate: new Date(Date.now() + 3600_000) }
})
```

</details>

<details> <summary>Payments & Business</summary>

```javascript
await sock.sendMessage(jid, { requestPaymentFrom: recipientJid, text: 'Payment for order #123' })
await sock.sendMessage(jid, { paymentInviteServiceType: 1 })
await sock.sendMessage(jid, { orderText: 'Your order summary', thumbnail: fs.readFileSync('./order-thumb.jpg') })
await sock.sendMessage(jid, { document: { url: './invoice.pdf' }, mimetype: 'application/pdf', invoiceNote: 'Invoice #1024' })

// sponsored ad card on any message
await sock.sendMessage(jid, {
  text: 'Check this deal!',
  externalAdReply: { title: 'Big Sale', body: '50% off', thumbnail: fs.readFileSync('./thumb.jpg'), mediaType: 1, url: 'https://example.com' }
})

await sock.sendMessage(jid, { requestPhoneNumber: true })
await sock.sendMessage(jid, { sharePhoneNumber: true })

await sock.sendMessage(jid, {
  groupInvite: { jid: groupJid, inviteCode: code, inviteExpiration: Date.now() + 3600_000, subject: 'My Group', text: 'Join us!' }
})

// disable forwarding
await sock.sendMessage(jid, { limitSharing: true })
```

</details>

<details> <summary>Status</summary>

```javascript
// jid can be an array to choose who sees the status
await sock.sendMessage([contactJid1, contactJid2], { text: 'Status update text' })
```

</details>

---

## Call

Calls need `ffmpeg` and `ffprobe` in `PATH`. Create one `Voip` per socket once it is open. After a reconnect there is a new socket, so create a new `Voip`.

<details> <summary>Quick start</summary>

```javascript
import Voip from '@hiroosy/baileys-lite/voip'

const voip = new Voip(sock, {
  ffprobePath: 'ffprobe',
  voipLogLevel: 'warn',         // trace | debug | info | warn | error
  tmpDir: './tmp',              // temp folder for downloads
  maxConcurrentCalls: 1         // see Multi Call
})

const call = await voip.call('628123456789', './song.mp3')

await call.hangup() // or call.end()

// ring only, no media
await voip.call('628123456789')
```

</details>

<details> <summary>Media & Playlist</summary>

```javascript
await voip.call(jid, './song.mp3')                    // local file
await voip.call(jid, 'https://example.com/song.mp3')  // url, downloaded first (audio max 20MB, video max 50MB)
await voip.call(jid, { audio: './voice.ogg' })
await voip.call(jid, './clip.mp4', '720p')            // video call

// audio: mp3 ogg opus wav m4a aac flac weba
// video: mp4 mov webm mkv avi m4v 3gp

// resolution (third argument): '240p' | '360p' | '480p' | '720p' | '1080p'
// or { width, height, frameRate }. Default is 480p, portrait sources are rotated automatically.

// playlist, items play in order and can mix audio and video
const list = await voip.call(
  jid,
  ['./intro.mp3', './clip.mp4', 'https://example.com/outro.mp3'],
  '480p',
  {
    loop: false,           // repeat the playlist
    autoEndCall: true,     // hang up when the playlist ends
    autoDowngrade: true    // drop to audio when the peer turns every camera off
  }
)
```

`jid` can be a number or a jid, non-digits are removed.

</details>

<details> <summary>Controls</summary>

```javascript
await call.silent(true)       // silence audio
await call.silent(false)      // resume
await call.silent()           // toggle
console.log(call.isSilenced)

call.mute(true)               // mic only
call.raiseHand(true)
call.react('👍')              // false if not connected yet
await call.shareScreen(true)  // needs video, 1:1 only
await call.shareScreen(false)

const result = await call.upgradeToVideo()
// 'accepted' | 'rejected' | 'rejected_by_timeout' | 'error' | 'timeout' | 'cancelled'
```

`shareScreen` only tells the peer a screen is shared. The picture is whatever you feed to `voip.coordinator.feedLiveVideo()`.

</details>

<details> <summary>Events</summary>

```javascript
call.on('ringing', () => {})
call.on('connected', () => {})
call.on('ended', reason => {})          // 'connection_closed' if the socket drops
call.on('error', err => {})

call.on('item', ({ index, kind, source }) => {})
call.on('playlist_looped', () => {})
call.on('playlist_ended', () => {})
call.on('downgraded', () => {})         // video dropped to audio
call.on('silent', state => {})

call.on('peer_mute', muted => {})
call.on('hand_raise', ({ jid, raised }) => {})
call.on('reaction', reaction => {})
call.on('screen_share', share => {})
call.on('peer_video', change => {})
call.on('inbound_audio', pcm => {})     // Float32Array, 16 kHz mono, 60 ms
call.on('inbound_video', frame => {})   // decoded H.264 frame
call.on('audio_finished', () => {})     // current audio item reached its end
```

</details>

<details> <summary>Incoming Calls</summary>

```javascript
await voip.listen() // register the call handlers, safe to call twice

voip.on('call_incoming', async call => {
  console.log('incoming from', call.peerJid, call.callId)
  await voip.acceptCall(call.callId)
})

voip.on('call_inbound_audio', ({ call, pcm }) => {})
voip.on('call_ended', call => console.log('ended', call.callId))

await voip.rejectCall(callId)
await voip.hangup(callId)

// events: call_incoming, call_state, call_ended, call_peer_mute, call_inbound_audio,
// call_inbound_video, call_hand_raise, call_reaction, call_screen_share,
// call_peer_video_state, call_outbound_audio_finished, call_error
```

`voip.coordinator` is the raw engine (`feedLiveAudio`, `feedLiveVideo`, `setExternalAudioMode`, ...).

</details>

<details> <summary>Multi Call</summary>

```javascript
const voip = new Voip(sock, { maxConcurrentCalls: 3 })

// one by one
const a = await voip.call('628111111111', './song.mp3')
const b = await voip.call('628222222222', './song.mp3')

// many numbers at once
const results = await voip.callMany(
  ['628111111111', '628222222222', '628333333333'],
  './song.mp3'
)

for (const { jid, call, error } of results) {
  if (error) {
    console.log(jid, 'failed:', error.message)
    continue
  }
  call.on('ended', reason => console.log(jid, 'ended:', reason))
  call.on('error', err => console.error(jid, err))
}

voip.calls                  // active calls
voip.calls[0].callId
voip.calls[0].target        // dialed number
await voip.hangup(callId)   // end one call
await voip.end()            // end all calls
await voip.end(true)        // only release the slots
```

- `maxConcurrentCalls` defaults to `1`. Each call gets its own relay, codec and audio.
- Incoming calls count toward the limit too.
- A call over the limit throws `Maximum concurrent calls reached`. In `callMany()` it is returned as `error` for that number and the rest still go through.
- `callMany()` takes the same media and options as `call()` and calls duplicate numbers once.
- A safety timeout emits `error` if a call never ends (starts at 105s).

</details>