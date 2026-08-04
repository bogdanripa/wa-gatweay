# CLAUDE.md — wa-gateway

Context for working on this repo. Read `README.md` first for what it is and how to deploy it; this file is about the constraints that aren't obvious from the code.

## What this is

A whapi.cloud-compatible WhatsApp gateway on Baileys, hosting N numbers in one process. It exists so [gepetel](https://github.com/bogdanripa/gepetel) (and other bots) can drop whapi.cloud for self-hosted infrastructure on a Raspberry Pi 5 running Pironman, **without changing their WhatsApp code**.

The compatibility contract is the whole point. If you change a payload shape or an endpoint, you break a bot that isn't in this repo.

## The contract with gepetel

gepetel is on GCP Cloud Functions and is *not* in this repo. Before touching `src/map.ts`, `src/jid.ts` or `src/routes.ts`, re-read what it actually consumes:

**Inbound** (`app.ts`, `POST /whapi`) — the branch order matters, it's an if/else chain:

```
message.text.body  →  message.gif.preview  →  message.image.preview (uses .link || .preview)
  →  message.voice.link || message.audio.link  →  message.link_preview.title  →  ignored
```

Also reads: `id`, `from_me`, `chat_id`, `chat_name`, `from`, `from_name`, plus `groups[]`, `contacts[]` and `messages_updates[]` (poll tallies as `{name, count, voters}`).

**Outbound** (`whapi.ts`) — 7 endpoints, listed in the README table.

**Id formats.** gepetel reduces every id with `String(x).replace(/\D/g, "")` and gates group ids on `/^[\d-]{10,31}@g\.us$/`. It infers each group's country, language and timezone from participant phone prefixes (`util.ts` `CALLING_CODES`), and hardcodes its own number in `BOT_PHONE_DIGITS`.

`test/gateway.test.mjs` transcribes gepetel's branching logic and id handling directly into the test file, so the tests fail if payloads drift. **Keep it that way** — asserting against this code's own shape would prove nothing.

## Things that will bite you

**LIDs.** WhatsApp is migrating identities from phone numbers to `…@lid`. An unresolved LID doesn't throw anywhere — it makes gepetel infer the wrong language for a group. Always resolve to a phone number before emitting an id: prefer `GroupParticipant.phoneNumber`, fall back to `signalRepository.lidMapping.getPNForLID()`. `toWhapiChatId` deliberately passes an unresolved LID through *unchanged* rather than reshaping it, so the bug stays visible.

**One instance, one session per number.** Two clients on the same credentials get `connectionReplaced` (440) and eventually a logout. The session stops rather than reconnecting; don't "fix" that by adding a retry. Config refuses to start on duplicate session ids or tokens for the same reason.

**Auth state must never touch the filesystem.** `useMultiFileAuthState` is a trap here — Pironman replaces the container on redeploy. Everything goes through `src/authState.ts`, namespaced `"<sessionId>:<key>"`. Credential write failures are logged at `error` and must stay that way; a silent failure means the session dies days later with no explanation.

**`messages.upsert` type.** Only `"notify"` is a live message. `"append"` is history backfill — forwarding it makes bots reply to week-old messages.

**Poll votes are encrypted** and can only be decrypted with the original creation message, which is why `polls` persists it as base64 proto.

**`getImageDescription` and `transcribeVoice` fetch URLs server-side** (from GCP and from OpenAI). Media links must be absolute, public HTTPS, and live long enough — they can't be `localhost` or bearer-protected.

## Layout

| File | Role |
|---|---|
| `config.ts` | env parsing + session validation (fails fast, deliberately) |
| `store.ts` | Mongo collections, TTL indexes, `scopedId` |
| `authState.ts` | Mongo-backed Baileys `AuthenticationState`, per session |
| `jid.ts` | **pure** — JID ↔ whapi id conversion |
| `map.ts` | **pure** — Baileys events → whapi payloads |
| `session.ts` | one number: socket lifecycle, reconnect, inbound/outbound |
| `sessions.ts` | SessionManager — token→session routing, isolated startup |
| `media.ts` | download, decrypt, serve, sweep |
| `webhook.ts` | serialised at-least-once delivery, one queue per session |
| `routes.ts` | whapi-compatible REST + admin UI |

`jid.ts` and `map.ts` are pure on purpose — all I/O is injected by `session.ts` so both stay unit-testable without a socket. Keep them that way.

## Testing

```bash
npm run build && npm test          # 28 unit tests, pure mappers
node test/smoke.mjs                # 30 boot checks, real mongod, two numbers
```

The smoke test spawns the real server and needs outbound network to WhatsApp — its QR checks verify a live WebSocket handshake. It also boots several deliberately-broken configs and asserts they exit non-zero.

There is no test that sends a real WhatsApp message; that needs a paired account. Anything touching send paths deserves a manual check against a real number before deploying.

## Conventions

- TypeScript, ESM, `NodeNext` resolution — **imports need the `.js` extension**.
- Comments explain *why*, especially where a choice looks odd (it usually encodes a gepetel constraint or a WhatsApp protocol quirk). Don't strip them.
- Baileys is pinned to a release-candidate. Bump deliberately and re-read `lib/**/*.d.ts` rather than trusting memory — the v7 API moved a lot.
