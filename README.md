# wa-gateway

A self-hosted WhatsApp gateway built on [Baileys](https://github.com/whiskeysockets/Baileys), speaking the **WhatsApp Cloud API**. A bot written against Meta's API works after a base-URL change and nothing else, and one instance hosts **several numbers at once**, each with its own token.

It owns the WhatsApp sessions and speaks two protocols:

- **Outbound (bot → gateway):** WhatsApp Cloud API request bodies and responses.
- **Inbound (gateway → bot):** WhatsApp Cloud API webhook payloads — the `entry/changes/value` envelope, with `group_id` on group messages.

```
                        ┌─ session "alpha-bot" ⇄ WhatsApp #1 ─┐   webhook     ┌─ your bot
wa-gateway (Pi 5) ──────┤                                       ├──────────────►│
                        └─ session "beta-bot"  ⇄ WhatsApp #2 ─┘                └─ another bot (anywhere)
                           ├─ Mongo-backed auth state, namespaced per session
                           └─ media downloaded, decrypted, served over HTTPS
```

Routing is by bearer token, as the hosted APIs do it. Each bot sends its own token and reaches its own number — which is why adding a second number is a config change on both sides and **no code change on either**.

Numbers are added, paired and removed from a web console at the deployment's root URL, without a redeploy. The gateway's own API sits under `/api` on the same host.

```
https://wa-gateway-coolify.bogdanripa.com/       management console (static)
https://wa-gateway-coolify.bogdanripa.com/api    the gateway  ← bots point here
```

---

## Why it's a separate service

A hosted API lets a bot be stateless, because the provider holds the WhatsApp session for it. Baileys **is** the session — a long-lived WebSocket plus Signal protocol state — which a request-scoped runtime cannot hold. So the sessions live here and the bots stay as they are.

Three consequences worth internalising before you deploy:

1. **Exactly one instance.** Two gateway instances on the same credentials fight over each device slot, and WhatsApp resolves that by logging you out. The gateway detects it (`connectionReplaced`) and deliberately *stops* that session rather than reconnecting into a flap war. Two sessions sharing an id would cause the same thing, so ids are unique by construction (they're the primary key) and tokens carry a unique index.
2. **Auth state lives in Mongo, not on disk.** Pironman replaces the container on every redeploy. Baileys' bundled `useMultiFileAuthState` writes files, so with it you'd re-scan every QR after each deploy — and the Baileys docs say outright not to use it in production.
3. **Media has to be re-hosted.** Consumers expect plain HTTPS links. Baileys hands you encrypted blobs. The gateway downloads, decrypts and serves them from its own public URL — which is what a bot, or a model it hands the URL to, actually fetches.

---

## Deploying on Pironman

The app is one Pironman app of kind **both**: a container serving `/api/*`, and a static bundle — the management console — serving everything else. That split isn't a preference; Pironman routes only `/api/*` to a container, and the rest is answered by the bundle without the container ever seeing it.

```bash
apps_create id=wa-gateway db_engine=mongo health_path=/api/health
github_secret_set PAAS_KEY=<the paas_key apps_create returned>
apps_deploy_workflow id=wa-gateway     # write .github/workflows/deploy.yml
git push                               # CI builds arm64, ships both halves

# Only now — a container has to exist before the platform will take env vars.
apps_env_set id=wa-gateway \
  WA_PUBLIC_URL=https://wa-gateway-coolify.bogdanripa.com \
  WA_MANAGEMENT_KEY=<openssl rand -base64 32>

apps_update id=wa-gateway sleep_when_idle=false
```

Three things that each cost a deploy to learn:

- **`health_path` must be a backend path.** `/` is answered by the static bundle with no container involved, so a healthcheck pointed there passes with the gateway dead.
- **`sleep_when_idle` must be off.** New backends get it on by default, and scaling to zero drops the WhatsApp WebSocket — the session *is* a long-lived connection, not a request handler.
- **The env vars come last, and that's fine.** The platform won't accept them for an app with no container, so the first deploy runs unconfigured: it boots healthy with the management API switched off and `/api/ready` naming what's missing. Set them, let it redeploy, and it's live.

No Mongo URL to set — `db_engine=mongo` attaches one and injects `DATABASE_URL`, which the gateway uses when `WA_MONGO_URL` is unset. Leave `WA_MONGO_DB` unset too: the credentials are scoped to the database named in that URL.

Build for the Pi's architecture. Building on the Pi itself is simplest; from x64 or CI you must cross-build:

```bash
docker buildx build --platform linux/arm64 -t <registry>/wa-gateway:latest --push .
```

### Adding a number

Open the console at `https://wa-gateway-coolify.bogdanripa.com/`, enter the management key, and fill in **Add a number**. Only the id is required: a token is generated and shown once, and a pairing QR appears on the new card straight away.

The webhook URL is optional, because pairing is the slow physical step and there's no reason to block it on a bot that doesn't exist yet. Add it later with **Edit**; until then the number can send, and inbound events are discarded rather than queued — a number left paired for a week shouldn't flood its bot with stale conversation the moment a URL appears.

The send rate cap is optional too, and empty means **no limit** rather than some default.

No redeploy, no environment variable, no restart. Budget roughly 40–80 MB of RAM per number, depending on how many groups it's in.

The id namespaces every stored document for that number, so it can't be edited after creation — changing it would orphan the credentials. Everything else (webhook URL, pairing phone, rate cap) is editable in place, and changing them doesn't disturb the WhatsApp connection.

### Pairing

Each number's card shows its own QR: scan with **WhatsApp → Settings → Linked devices → Link a device**. The console re-polls fast enough to keep up with WhatsApp rotating the code.

If scanning a screen is awkward, set that number's **pairing phone** (digits, with country code) and the card shows an 8-character code for **Link with phone number** instead.

The console is also where you recover a number: **Restart** bounces a stuck socket, **Unlink & re-pair** wipes its credentials and shows a fresh QR, **Rotate token** issues a new bot credential, and **Delete** removes the number and purges everything stored for it.

### Alerts

A number that quietly loses its connection is the failure that actually costs you: the bot goes silent, nobody notices for a day, and the first sign is someone asking why they were ignored. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (shared platform-wide on Pironman, so every app uses the same bot) and the gateway tells you.

The whole design problem is noise. WhatsApp drops sockets constantly and Baileys reconnects in seconds — alerting on every `connection: close` would train you to ignore alerts within an hour, which is worse than having none. So a routine drop gets a three-minute grace period and never alerts if it recovers; `logged-out` and `conflict` alert immediately because they never self-heal; a number that has never connected is treated as unpaired rather than broken; and recovery is announced so a resolved alert doesn't leave you guessing.

### Health

- **`/api/health`** — liveness. 200 whenever the process is up, *including with zero numbers configured*, because Pironman gates deploys on it: a readiness check here would mean a fresh deployment could never go healthy long enough for anyone to add the first number. Counts only, no identifying detail — it is unauthenticated.
- **`/api/ready`** — readiness. 503 until every configured number is connected, so one unpaired number can't hide behind a green light. This is the one to watch.

### Pointing a bot at it

Two configuration values, no code change:

```
BASE_URL = https://<your-host>/api
TOKEN    = <the token the console showed for that number>
```

Note the `/api`. Every path *below* the base URL is what a client hardcodes, and those are unchanged — so if a bot builds requests as `${BASE_URL}/…`, the base is the only thing that moves. If it hardcodes a provider's host instead, lifting that into a variable is the one edit required, and it makes rolling back a config change too.

---

## What's implemented

Paths are relative to the base URL, which is `https://<host>/api`:

| Endpoint | |
|---|---|
| `POST /<PHONE_NUMBER_ID>/messages` | every send — text, media, location, reaction, poll, and the `status: "read"` update |
| `GET /groups/:id` | a group's roster and subject |

One send endpoint, as Meta has it. The per-verb routes this started with (`/messages/text`, `/messages/image`, `/messages/poll`, `PUT /messages/:id`, `PUT /messages/:id/reaction`, `PUT /presences/:to`) are gone — each was a second way to say what the Cloud shape already says, and two surfaces mean two to keep honest.

Inbound webhook events: `messages[]` (text, image, GIF, voice, audio, link preview), `groups[]`, `contacts[]`, `messages_updates[]` (poll tallies).

Plus gateway-only: `GET /api/health`, `GET /api/ready`, `GET /api/media/:id`.

And the management API behind the console, all of it requiring `Authorization: Bearer <WA_MANAGEMENT_KEY>`:

| Endpoint | |
|---|---|
| `GET /api/mgmt/numbers` | every number, with status, QR and token |
| `POST /api/mgmt/numbers` | add one; returns its generated token |
| `PATCH /api/mgmt/numbers/:id` | edit webhook URL, pairing phone, rate cap |
| `POST /api/mgmt/numbers/:id/rotate-token` | issue a new bot token, revoking the old |
| `POST /api/mgmt/numbers/:id/relink` | unlink from WhatsApp and show a fresh QR |
| `POST /api/mgmt/numbers/:id/restart` | bounce the socket, keeping credentials |
| `DELETE /api/mgmt/numbers/:id` | remove the number and purge its state |

---

## Design notes

**LID resolution is the subtle one.** WhatsApp is migrating identities from phone numbers to LIDs (`…@lid`). Consumers infer a group's country from participant phone prefixes, so an unresolved LID doesn't crash anything — it quietly makes them answer wrongly. Silent wrongness being the worst failure mode available, the gateway resolves LIDs aggressively (preferring the phone-number form Baileys ships on the message key itself, then a participant's `phoneNumber`, then the Signal LID mapping store), logs a warning when it can't, and never reshapes a LID into something that merely *looks* like a phone number.

**Message keys are cached because the API is id-only.** `PUT /messages/{id}` passes just an id, but Baileys needs the full key (`remoteJid`, `fromMe`, `participant`). Every message seen or sent gets its key stored in Mongo, scoped to its session, with a 7-day TTL.

**Poll creation messages are persisted** because vote updates arrive encrypted and can only be decrypted with the original message — which has to outlive the process.

**Webhook delivery is serialised per session and retried.** A bot that threads a conversation is corrupted by out-of-order delivery, so each session has its own queue and a slow bot backs up only its own number. Retries mean a handler can see the same message twice — dedupe on message id, which is the same requirement every hosted API imposes.

**Sessions fail independently.** One number with a corrupt auth document, a logout, or a conflict doesn't stop the others from starting or running.

**Non-GIF videos, stickers and documents are dropped at the gateway.** There is no payload shape for them, so forwarding an empty envelope would only make a consumer log and discard it.

---

## Tests

```bash
npm run build
npm test              # 28 unit tests — pure mappers
npm run test:smoke    # 49 boot checks against a real mongod, two numbers
```

The webhook and send-shape tests assert against **examples from Meta's published documentation**, not against this code's own output — so they fail if the payloads drift from what a Cloud API client expects. Asserting against our own shapes would prove only self-consistency.

The smoke test boots the real server process with **no** numbers configured — a fresh deployment — then adds two through the management API and checks token routing, management-key enforcement, per-session credential isolation in Mongo, and that a deleted number takes its credentials with it while leaving the other's alone. It restarts the process to prove numbers added at runtime outlive the container, and boots several deliberately-broken configs to confirm they exit non-zero. Its QR check only passes when **both** numbers complete a live WebSocket handshake with WhatsApp.

To work on the console without deploying:

```bash
npm run dev:console
```

That starts an in-memory mongod, the real gateway, and a local stand-in for Pironman's proxy on `http://127.0.0.1:8080` — static bundle at the root, `/api/*` forwarded to the container. Reproducing that split locally is the point: a path bug that only shows up under the real proxy is a slow one to find.

---

## Operating it

- **`/api/ready` is 503?** It tells you which number. Open the console — either it needs pairing or it's mid-reconnect.
- **A session shows `conflict`?** Another client is using those credentials. Check for a second gateway instance, then hit **Restart** on its card.
- **A session shows `logged-out`?** That device was unlinked from the phone. Only that session's credentials are wiped; use **Unlink & re-pair** on its card for a fresh QR.
- **Lost a bot's token?** The console shows it — **Show token** on that number's card. If it leaked, **Rotate token** revokes it immediately, and the bot goes silent until its token is updated.
- **`FAILED TO PERSIST CREDENTIALS` in the logs?** Fix it immediately — that session won't survive the next restart.
- **Disk filling up?** Media is swept hourly against `WA_MEDIA_TTL_HOURS`, but a chatty month of images across several numbers adds up on a Pi.

---

## The obvious caveat

This is a reverse-engineered client and against WhatsApp's Terms of Service. Baileys' own maintainers discourage bulk or automated messaging. A personal bot on your own number in your own groups is the lowest-risk profile there is, and a per-number rate cap is available to keep a bug from turning into a ban. Don't point this at cold outreach.

WhatsApp also ships protocol changes that break Baileys periodically. Pin the version, and expect to bump it a few times a year. Note that with several numbers on one instance, a breaking change takes them all down at once.
