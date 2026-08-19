# CLAUDE.md — wa-gateway

Context for working on this repo. Read `README.md` first for what it is and how to deploy it; this file is about the constraints that aren't obvious from the code.

## What this is

A WhatsApp gateway on Baileys, hosting N numbers in one process, running on a Raspberry Pi 5 under Pironman. It exists so bots can drop a hosted WhatsApp API for self-hosted infrastructure **without changing their WhatsApp code**.

The compatibility contract is the whole point. Every consumer is a separate codebase you cannot see from here, so a changed payload shape or endpoint breaks something you have no way to test.

"Endpoint" means the path *below the base URL*. Everything is served under `/api` because Pironman routes only `/api/*` to a container and answers every other path from the static bundle — which is the management console. A client's base URL carries the prefix; `/<PHONE_NUMBER_ID>/messages` and the rest are untouched below it, and they must stay that way.

## The contract with consumers

Consumers are not in this repo, and there is no way to test against them from here. Two surfaces are load-bearing:

**Outbound (bot → gateway).** `POST /<PHONE_NUMBER_ID>/messages` in WhatsApp Cloud API shape, and nothing else. The older per-verb routes (`/messages/text` and friends) are gone: each was a second way to say what the Cloud shape already says. The path segment is cosmetic — the bearer token identifies the number — which is what makes migrating a base-URL change.

`GET /groups/:id` survives that removal because Meta has no equivalent, so dropping it would lose a capability rather than a duplicate.

**Inbound (gateway → bot).** WhatsApp Cloud API webhooks only: the `entry[].changes[].value` envelope, `metadata`, `contacts[].profile.name`, and `messages[]` with `group_id` set on group messages and the participant in `from`. `cloud.ts` owns every byte of this.

**Id formats.** Consumers reduce ids with `String(x).replace(/\D/g, "")`, guard group ids on something like `/^[\d-]{10,31}@g\.us$/`, and infer a country from the calling-code prefix. That last one is why an unresolved LID is dangerous rather than merely wrong — see below.

`test/gateway.test.mjs` asserts the Cloud shapes against **examples taken from Meta's published documentation**, not against this code. **Keep it that way** — asserting against our own output would prove only that we are self-consistent, which is not the promise being made.

## Things that will bite you

**LIDs.** WhatsApp is migrating identities from phone numbers to `…@lid`. An unresolved LID doesn't throw anywhere — it makes a consumer infer the wrong country for a group. This bit in production: senders arrived as `139556506575001`, which is a LID's digits, not a number.

Resolve in this order, and don't drop a step:

1. **`key.participantAlt` / `key.remoteJidAlt`** — Baileys v7 ships the phone-number form on the message key itself when the chat is LID-addressed. It's WhatsApp's own mapping, needs no lookup, and works on a cold start. `preferPhoneNumber` in `jid.ts` is this rule, and it's unit-tested.
2. `GroupParticipant.phoneNumber` for rosters.
3. `signalRepository.lidMapping.getPNForLID()`, which only works if the mapping store was populated — see the history-sync note below.
4. Failing all that, warn loudly and pass the LID through unchanged. `toChatId` deliberately does not reshape it, so the bug stays visible.

Resolutions from step 1 are written back with `storeLIDPNMappings`, so later events that arrive without an alt (poll votes, rosters) hit the cache.

LIDs leak through the message **body** too, not just id fields: WhatsApp writes only a JID's user part into the text, so a mention in a LID-addressed group reads `@81656102801535`. `resolveMentions` rewrites those, building its mapping from `contextInfo.mentionedJid` — never by pattern-matching the text, which would also rewrite a number somebody typed by hand. An unresolvable mention stays a LID, for the same reason `toChatId` doesn't reshape one.

**History sync is an allow-list, not off.** `shouldSyncHistoryMessage: () => false` looks harmless — the bots never read history — but it disables all seven of Baileys' sync types, and two of them carry the LID↔phone mappings and the contact/chat names. Baileys says so on connect ("DANGER: … PREVENTS BAILEYS FROM ACCESSING INITIAL LID MAPPINGS"), and the symptom is item 3 above silently returning null forever. Allow `INITIAL_BOOTSTRAP`, `PUSH_NAME` and `NON_BLOCKING_DATA`; keep refusing `FULL`/`RECENT`/`ON_DEMAND`, which are the actual message backfill. Nothing from a sync can reach a bot anyway — `onMessages` only forwards `type === "notify"`.

Turning sync on means a burst of `contacts.update` on every connect, which is why `onContacts` dedupes against what it has already emitted. Without that, a bot gets told the same name dozens of times per reconnect.

**One instance, one session per number.** Two clients on the same credentials get `connectionReplaced` (440) and eventually a logout. The session stops rather than reconnecting; don't "fix" that by adding a retry. Ids are unique because they're the `sessions` primary key, and tokens carry a unique index, for the same reason.

The console can now bounce a socket on demand (`restart`, `relink`, `remove`), which makes it possible to *self-inflict* that conflict: a socket torn down asynchronously still emits its `close`, and that handler would schedule a reconnect on top of its replacement. `Session.generation` is what prevents it — every socket gets a number and its handlers no-op once they aren't current. Anything that creates or discards a socket must bump it.

**Sessions live in Mongo, not the environment.** `WA_SESSION_n_*` is gone. The set of numbers is mutable at runtime because the console edits it, so validation that used to crash the process at boot now has to come back as a 400 — that's what `sessionStore.ts` is for, and its rules are the old ones. Mongo is the source of truth; `SessionManager`'s maps are a cache, so every mutation writes first.

A session id can never change: it namespaces every other document (`"<id>:<key>"`). Reusing a deleted id is safe only because `remove()` purges the credentials — if you make deletion lazier, a recreated id silently adopts a dead account's device slot, which presents as "the QR never appears" with nothing in the logs.

**Auth state must never touch the filesystem.** `useMultiFileAuthState` is a trap here — Pironman replaces the container on redeploy. Everything goes through `src/authState.ts`, namespaced `"<sessionId>:<key>"`. Credential write failures are logged at `error` and must stay that way; a silent failure means the session dies days later with no explanation.

**`/api/health` is liveness, `/api/ready` is readiness — don't merge them back.** Health used to be the strict one, and with sessions in Mongo that deadlocks a deployment: no numbers configured → not ready → Pironman's deploy gate never goes green → nobody can reach the console to add the first number. Health is therefore 200 whenever the process is up.

It is also unauthenticated, because the healthcheck and deploy gate request it that way. It must never carry identifying detail — it previously returned every session's full state, **pairing code included**, to anyone on the internet. A pairing code is the QR in text form: whoever reads one during a pairing window links their own device to the number. That's why `Session.describe()` is deliberately thin and `describeForManagement()` is the one behind the key.

**An unconfigured gateway boots inert — don't "fix" that back into a crash.** Everything else in `config.ts` fails fast, and `WA_MANAGEMENT_KEY` used to as well. It can't: the platform will not accept environment variables for an app that has never produced a running container, so a gateway that refuses to boot without its key can never *be* given one. The first deploy of any fresh install is unconfigured by construction.

It is fail-*closed*, not lax: no key means the management router is replaced wholesale with a 503, so there is no compare to get wrong — in particular no empty-string key matching an empty bearer token. A key that is present but too short still throws.

**`WA_MONGO_DB` empty means "whatever the connection string names."** A managed database's user is authorised for exactly the database in its URL path. A hardcoded name doesn't fail at connect — it connects, then throws `Unauthorized` on the first `createIndex`, which reads like a broken schema. That cost a deploy; the error is now wrapped to say so.

**Connection alerts must stay quiet to stay useful.** `alerts.ts` deliberately does *not* fire on every disconnect: WhatsApp drops sockets constantly and Baileys reconnects within seconds, so a naive alert-on-close trains the operator to ignore it within an hour. The grace period, the immediate path for `logged-out`/`conflict`, and the "never connected is not an incident" rule are the whole point — don't simplify them away. A failed alert must never take down the thing it is watching, which is why every send is caught.

**Everything is WhatsApp Cloud API shaped, both directions.** `cloud.ts` builds every outbound event and parses every send; the older payload builders, the per-number dialect setting and the per-verb send routes are all gone. One shape, one place to keep honest.

`cloud.ts` is pure for the same reason `map.ts` is, and its tests assert against shapes lifted from Meta's own documentation — not against this code. That is the only thing that can prove the migration promise.

`map.ts` is now just `classify`/`unwrap`: what kind of message is this, and what must be fetched before forwarding. It no longer knows any payload shape.

The Cloud route's path segment (`/<PHONE_NUMBER_ID>/messages`) is deliberately **not** used for routing: the token already identifies one number, which is what makes migrating a base-URL change. It is still checked against *other* numbers' identifiers, because a segment naming a different configured number is a real misconfiguration rather than a harmless one.

Meta's group support is narrower than it looks — its Groups API only addresses groups the business created, with the business as admin. We use its *format* and apply it to any group the linked number is in. Don't "fix" the docs to claim parity.

**The management key is the keys to every number.** It creates sessions, reads every bot's token, and can unlink an account — from the public internet. Compare it in constant time, keep the failed-attempt throttle, and don't let a session token reach `/api/mgmt/*` (a compromised bot must not be able to enumerate the others). `trust proxy` is set for the throttle's benefit: without it every request looks like it came from Pironman's proxy and one attacker locks out the operator.

**`messages.upsert` type.** Only `"notify"` is a live message. `"append"` is history backfill — forwarding it makes bots reply to week-old messages.

**Poll votes are encrypted** and can only be decrypted with the original creation message, which is why `polls` persists it as base64 proto.

**`getImageDescription` and `transcribeVoice` fetch URLs server-side** (from GCP and from OpenAI). Media links must be absolute, public HTTPS, and live long enough — they can't be `localhost` or bearer-protected.

## Layout

| File | Role |
|---|---|
| `config.ts` | env parsing (fails fast, deliberately) + `API_PREFIX` |
| `store.ts` | Mongo collections, TTL indexes, `scopedId` |
| `sessionStore.ts` | **pure-ish** — session config CRUD + the validation rules |
| `authState.ts` | Mongo-backed Baileys `AuthenticationState`, per session |
| `jid.ts` | **pure** — JID ↔ emitted id conversion |
| `map.ts` | **pure** — Baileys message → classification |
| `session.ts` | one number: socket lifecycle, reconnect, inbound/outbound |
| `sessions.ts` | SessionManager — token→session routing, runtime add/remove |
| `media.ts` | download, decrypt, serve, sweep |
| `webhook.ts` | serialised at-least-once delivery, one queue per session |
| `routes.ts` | Cloud API send, groups, health/media, management API |
| `alerts.ts` | Telegram connection alerts, deliberately debounced |
| `frontend/` | the console — plain HTML/CSS/JS, no build step |
| `dev/serve.mjs` | local stand-in for Pironman's static + `/api` proxy split |

`jid.ts` and `map.ts` are pure on purpose — all I/O is injected by `session.ts` so both stay unit-testable without a socket. Keep them that way.

## Testing

```bash
npm run build && npm test          # 28 unit tests, pure mappers
npm run test:smoke                 # 49 boot checks, real mongod, two numbers
npm run dev:console                # the console on http://127.0.0.1:8080
```

`npm test` globs `test/*.test.mjs`, not `test/*.mjs` — the smoke test is a standalone script, and `node --test` would happily run it as a test file, spawning a mongod and a real WhatsApp connection every time anyone ran the unit tests.

The smoke test spawns the real server and needs outbound network to WhatsApp — its QR checks verify a live WebSocket handshake. It starts with **zero** numbers, adds them over the management API, and restarts the process to prove they outlive the container. It also boots several deliberately-broken configs and asserts they exit non-zero.

`dev:console` reproduces Pironman's routing locally (static bundle at `/`, `/api/*` proxied to the container). Test console changes there — the split is the part that bites.

There is no test that sends a real WhatsApp message; that needs a paired account. Anything touching send paths deserves a manual check against a real number before deploying.

## Conventions

- TypeScript, ESM, `NodeNext` resolution — **imports need the `.js` extension**.
- Comments explain *why*, especially where a choice looks odd (it usually encodes a consumer constraint or a WhatsApp protocol quirk). Don't strip them.
- Baileys is pinned to a release-candidate. Bump deliberately and re-read `lib/**/*.d.ts` rather than trusting memory — the v7 API moved a lot.
