# wa-gateway

A self-hosted, whapi.cloud-compatible WhatsApp gateway built on [Baileys](https://github.com/whiskeysockets/Baileys). It replaces whapi for [gepetel](https://github.com/bogdanripa/gepetel) with an 8-line diff on gepetel itself, and hosts **several numbers at once** the same way a whapi account holds several channels.

It owns the WhatsApp sessions and speaks two protocols:

- **Outbound (bot → gateway):** the same REST endpoints whapi exposes, same paths, same request bodies, same response shapes.
- **Inbound (gateway → bot):** the same webhook payloads whapi POSTs to `/whapi`.

```
                        ┌─ session "gepetel"    ⇄ WhatsApp #1 ─┐  POST /whapi   ┌─ gepetel (GCP)
wa-gateway (Pi 5) ──────┤                                       ├──────────────►│
                        └─ session "second-bot" ⇄ WhatsApp #2 ─┘                └─ other bot (anywhere)
                           ├─ Mongo-backed auth state, namespaced per session
                           └─ media downloaded, decrypted, served over HTTPS
```

Routing is by bearer token, exactly as whapi does it. Each bot sends its own token and reaches its own number — which is why adding a second number is a config change on both sides and **no code change on either**.

---

## Why it's a separate service

gepetel is a stateless Cloud Function because whapi held the session for it. Baileys **is** the session — a long-lived WebSocket plus Signal protocol state. Those are incompatible runtimes, so the sessions live here and the bots stay as they are.

Three consequences worth internalising before you deploy:

1. **Exactly one instance.** Two gateway instances on the same credentials fight over each device slot, and WhatsApp resolves that by logging you out. The gateway detects it (`connectionReplaced`) and deliberately *stops* that session rather than reconnecting into a flap war. Two sessions sharing an `_ID` would cause the same thing, so the config refuses to start on duplicates.
2. **Auth state lives in Mongo, not on disk.** Pironman replaces the container on every redeploy. Baileys' bundled `useMultiFileAuthState` writes files, so with it you'd re-scan every QR after each deploy — and the Baileys docs say outright not to use it in production.
3. **Media has to be re-hosted.** whapi handed the bots plain HTTPS links. Baileys hands you encrypted blobs. The gateway downloads, decrypts and serves them from its own public URL, which is what the bots and OpenAI fetch.

---

## Deploying on Pironman

```bash
apps_create id=wa-gateway image=<your-registry>/wa-gateway:latest

apps_env_set id=wa-gateway \
  WA_MONGO_URL=...  WA_MONGO_DB=wa_gateway \
  WA_PUBLIC_URL=https://wa-gateway-coolify.bogdanripa.com \
  WA_ADMIN_PASSWORD=<generate one> \
  WA_SESSION_1_ID=gepetel \
  WA_SESSION_1_TOKEN=<generate one> \
  WA_SESSION_1_WEBHOOK_URL=https://<cloud-function-host>/whapi

apps_deploy_workflow id=wa-gateway
apps_logs id=wa-gateway
```

Build for the Pi's architecture. Building on the Pi itself is simplest; from x64 or CI you must cross-build:

```bash
docker buildx build --platform linux/arm64 -t <registry>/wa-gateway:latest --push .
```

### Adding a second number

```bash
apps_env_set id=wa-gateway \
  WA_SESSION_2_ID=second-bot \
  WA_SESSION_2_TOKEN=<generate one> \
  WA_SESSION_2_WEBHOOK_URL=https://<other-bot-host>/whapi
apps_deploy_workflow id=wa-gateway
```

Then pair it at `/admin` and set that bot's `WHAPI_TOKEN` to the new token. Budget roughly 40–80 MB of RAM per number, depending on how many groups it's in.

`_ID` namespaces every stored document for that number — **never change it on a live session** or you orphan its credentials and it'll ask to pair again.

### Pairing

Open `https://wa-gateway-coolify.bogdanripa.com/admin` (any username, `WA_ADMIN_PASSWORD` as the password). Each number gets its own card with its own QR: scan with **WhatsApp → Settings → Linked devices → Link a device**.

If scanning a screen is awkward, set `WA_SESSION_<n>_PAIR_PHONE` to that number (digits only, with country code) and the card shows an 8-character code for **Link with phone number** instead.

`/health` is **200 only when every configured number is connected**, so one unpaired number can't hide behind a green light.

### Switching a bot over

Apply `gepetel-wa-gateway.patch` (8 changed lines — it swaps the hardcoded whapi host for a `WHAPI_BASE_URL` env var that defaults to whapi.cloud), then in GCP Secret Manager:

```
WHAPI_BASE_URL = https://wa-gateway-coolify.bogdanripa.com
WHAPI_TOKEN    = <that session's WA_SESSION_n_TOKEN>
```

`WHAPI_TOKEN` keeps its name and is still sent as `Authorization: Bearer …`; it's just the gateway's token now, and it's what selects the number. **Rolling back is unsetting `WHAPI_BASE_URL`.** Keep the whapi channel alive for a week so that's a real option.

---

## What's implemented

Exactly gepetel's whapi surface, nothing more:

| Endpoint | Used by the bot for |
|---|---|
| `GET /groups/:id` | authoritative roster + group subject |
| `POST /messages/text` | every reply, gossip and reminder |
| `POST /messages/image` | generated images |
| `POST /messages/poll` | native polls |
| `PUT /messages/:id` | mark as read (blue ticks) |
| `PUT /messages/:id/reaction` | emoji reactions |
| `PUT /presences/:to` | typing indicator |

Inbound webhook events: `messages[]` (text, image, GIF, voice, audio, link preview), `groups[]`, `contacts[]`, `messages_updates[]` (poll tallies).

Plus gateway-only: `GET /health`, `GET /admin`, `POST /admin/:id/logout`, `GET /media/:id`.

---

## Design notes

**LID resolution is the subtle one.** WhatsApp is migrating identities from phone numbers to LIDs (`…@lid`). gepetel infers each group's country, language and timezone from participant phone prefixes, so an unresolved LID doesn't crash it — it quietly makes it answer in the wrong language. Silent wrongness being the worst failure mode available, the gateway resolves LIDs aggressively (preferring the `phoneNumber` field Baileys puts on every participant, falling back to the Signal LID mapping store), logs a warning when it can't, and never reshapes a LID into something that merely *looks* like a phone number.

**Message keys are cached because whapi's API is id-only.** `PUT /messages/{id}` passes just an id, but Baileys needs the full key (`remoteJid`, `fromMe`, `participant`). Every message seen or sent gets its key stored in Mongo, scoped to its session, with a 7-day TTL.

**Poll creation messages are persisted** because vote updates arrive encrypted and can only be decrypted with the original message — which has to outlive the process.

**Webhook delivery is serialised per session and retried.** gepetel threads conversations through OpenAI response ids, so out-of-order delivery corrupts the thread. Each session has its own queue, so a slow bot backs up only its own number. Retries are safe because gepetel already dedupes on message id — that was whapi's contract too, so matching it keeps gepetel's idempotency code honest rather than letting it rot.

**Sessions fail independently.** One number with a corrupt auth document, a logout, or a conflict doesn't stop the others from starting or running.

**Non-GIF videos, stickers and documents are dropped at the gateway.** gepetel has no branch for them and would hit its `console.error` + skip path on every one.

---

## Tests

```bash
npm run build
npm test              # 28 unit tests — pure mappers
node test/smoke.mjs   # 30 boot checks against a real mongod, two numbers
```

The unit tests assert against **gepetel's actual branching logic**, transcribed from its `app.ts` into the test file, rather than against this code's own shape — so they fail if the payloads drift from what gepetel reads.

The smoke test boots the real server process with two numbers configured and checks token routing, per-session credential isolation in Mongo, and that misconfigurations (duplicate id, duplicate token, bad id, missing webhook) refuse to start rather than half-working. Its QR check only passes when **both** numbers complete a live WebSocket handshake with WhatsApp.

---

## Operating it

- **`/health` is 503?** It tells you which number. Check `/admin` — either it needs pairing or it's mid-reconnect.
- **A session shows `conflict`?** Another client is using those credentials. Check for a second gateway instance, then restart.
- **A session shows `logged-out`?** That device was unlinked from the phone. Only that session's credentials are wiped; re-pair from its card on `/admin`.
- **`FAILED TO PERSIST CREDENTIALS` in the logs?** Fix it immediately — that session won't survive the next restart.
- **Disk filling up?** Media is swept hourly against `WA_MEDIA_TTL_HOURS`, but a chatty month of images across several numbers adds up on a Pi.

---

## The obvious caveat

This is a reverse-engineered client and against WhatsApp's Terms of Service. Baileys' own maintainers discourage bulk or automated messaging. A personal bot on your own number in your own groups is the lowest-risk profile there is, and the per-session rate limiter keeps a bug from turning into a ban. Don't point this at cold outreach.

WhatsApp also ships protocol changes that break Baileys periodically. Pin the version, and expect to bump it a few times a year. Note that with several numbers on one instance, a breaking change takes them all down at once.
