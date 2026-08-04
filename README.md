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

Numbers are added, paired and removed from a web console at the deployment's root URL, without a redeploy. The gateway's own API sits under `/api` on the same host.

```
https://wa-gateway-coolify.bogdanripa.com/       management console (static)
https://wa-gateway-coolify.bogdanripa.com/api    the gateway  ← bots point here
```

---

## Why it's a separate service

gepetel is a stateless Cloud Function because whapi held the session for it. Baileys **is** the session — a long-lived WebSocket plus Signal protocol state. Those are incompatible runtimes, so the sessions live here and the bots stay as they are.

Three consequences worth internalising before you deploy:

1. **Exactly one instance.** Two gateway instances on the same credentials fight over each device slot, and WhatsApp resolves that by logging you out. The gateway detects it (`connectionReplaced`) and deliberately *stops* that session rather than reconnecting into a flap war. Two sessions sharing an id would cause the same thing, so ids are unique by construction (they're the primary key) and tokens carry a unique index.
2. **Auth state lives in Mongo, not on disk.** Pironman replaces the container on every redeploy. Baileys' bundled `useMultiFileAuthState` writes files, so with it you'd re-scan every QR after each deploy — and the Baileys docs say outright not to use it in production.
3. **Media has to be re-hosted.** whapi handed the bots plain HTTPS links. Baileys hands you encrypted blobs. The gateway downloads, decrypts and serves them from its own public URL, which is what the bots and OpenAI fetch.

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

### Health

- **`/api/health`** — liveness. 200 whenever the process is up, *including with zero numbers configured*, because Pironman gates deploys on it: a readiness check here would mean a fresh deployment could never go healthy long enough for anyone to add the first number. Counts only, no identifying detail — it is unauthenticated.
- **`/api/ready`** — readiness. 503 until every configured number is connected, so one unpaired number can't hide behind a green light. This is the one to watch.

### Switching a bot over

Apply `gepetel-wa-gateway.patch` (8 changed lines — it swaps the hardcoded whapi host for a `WHAPI_BASE_URL` env var that defaults to whapi.cloud), then in GCP Secret Manager:

```
WHAPI_BASE_URL = https://wa-gateway-coolify.bogdanripa.com/api
WHAPI_TOKEN    = <the token the console showed for that number>
```

Note the `/api`. Every path *below* the base URL is byte-identical to whapi's, which is the part gepetel hardcodes; the base itself was already a variable, so this is a config value and not a code change.

`WHAPI_TOKEN` keeps its name and is still sent as `Authorization: Bearer …`; it's just the gateway's token now, and it's what selects the number. **Rolling back is unsetting `WHAPI_BASE_URL`.** Keep the whapi channel alive for a week so that's a real option.

---

## What's implemented

Exactly gepetel's whapi surface, nothing more. Paths are relative to `WHAPI_BASE_URL`, which is `https://<host>/api`:

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
npm run test:smoke    # 49 boot checks against a real mongod, two numbers
```

The unit tests assert against **gepetel's actual branching logic**, transcribed from its `app.ts` into the test file, rather than against this code's own shape — so they fail if the payloads drift from what gepetel reads.

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
- **Lost a bot's token?** The console shows it — **Show token** on that number's card. If it leaked, **Rotate token** revokes it immediately, and the bot goes silent until its `WHAPI_TOKEN` is updated.
- **`FAILED TO PERSIST CREDENTIALS` in the logs?** Fix it immediately — that session won't survive the next restart.
- **Disk filling up?** Media is swept hourly against `WA_MEDIA_TTL_HOURS`, but a chatty month of images across several numbers adds up on a Pi.

---

## The obvious caveat

This is a reverse-engineered client and against WhatsApp's Terms of Service. Baileys' own maintainers discourage bulk or automated messaging. A personal bot on your own number in your own groups is the lowest-risk profile there is, and a per-number rate cap is available to keep a bug from turning into a ban. Don't point this at cold outreach.

WhatsApp also ships protocol changes that break Baileys periodically. Pin the version, and expect to bump it a few times a year. Note that with several numbers on one instance, a breaking change takes them all down at once.
