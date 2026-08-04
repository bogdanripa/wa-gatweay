import { test } from "node:test";
import assert from "node:assert/strict";

import {
    digitsOf,
    isGroupJid,
    looksLikePhoneNumber,
    stripDevice,
    toWaJid,
    toWhapiChatId,
    toWhapiUserId,
} from "../dist/jid.js";
import {
    buildWhapiGroupEvent,
    buildWhapiMessage,
    buildWhapiPollUpdate,
    classify,
    unwrap,
} from "../dist/map.js";

const GROUP = "120363012345678901@g.us";
const USER = "40750271099@s.whatsapp.net";

/**
 * gepetel's own group-id guard, copied verbatim from its whapi.ts. Anything the
 * gateway emits as a chat_id for a group must satisfy it or getGroupInfo
 * short-circuits to an empty roster.
 */
const GEPETEL_GROUP_RE = /^[\d-]{10,31}@g\.us$/;

/**
 * gepetel's webhook branching, transcribed from app.ts. Tests assert against
 * this rather than against my own payload shape, so the tests fail if I drift
 * from what gepetel actually reads.
 */
function gepetelBranch(message) {
    if (message.text && message.text.body) return { branch: "text", value: message.text.body };
    if (message.gif && message.gif.preview) return { branch: "gif", value: message.gif.preview };
    if (message.image && message.image.preview)
        return { branch: "image", value: message.image.link || message.image.preview };
    if ((message.voice && message.voice.link) || (message.audio && message.audio.link))
        return { branch: "voice", value: (message.voice || message.audio).link };
    if (message.link_preview) return { branch: "link_preview", value: message.link_preview.title };
    return { branch: "ignored", value: null };
}

// ---------------------------------------------------------------------- jid

test("group jids survive gepetel's group-id regex", () => {
    const chatId = toWhapiChatId(GROUP);
    assert.equal(chatId, GROUP);
    assert.ok(GEPETEL_GROUP_RE.test(chatId), `${chatId} must match gepetel's group regex`);
});

test("legacy dashed group ids also match", () => {
    const legacy = "120363012345678-1234567890@g.us";
    assert.ok(GEPETEL_GROUP_RE.test(toWhapiChatId(legacy)));
});

test("user jids normalise to <digits>@s.whatsapp.net", () => {
    assert.equal(toWhapiChatId(USER), USER);
    assert.equal(toWhapiChatId("40750271099"), USER);
});

test("device suffixes are stripped (Baileys sends 4075...:12@s.whatsapp.net)", () => {
    assert.equal(stripDevice("40750271099:12@s.whatsapp.net"), USER);
    assert.equal(toWhapiChatId("40750271099:12@s.whatsapp.net"), USER);
    assert.equal(toWhapiUserId("40750271099:12@s.whatsapp.net"), "40750271099");
});

test("digitsOf matches gepetel's String(x).replace(/\\D/g,'') exactly", () => {
    for (const input of [USER, "40750271099", "+40 750 271 099", GROUP]) {
        assert.equal(digitsOf(input), String(input).replace(/\D/g, "").replace(/@.*/, ""));
    }
});

test("BOT_PHONE_DIGITS matching still works through the gateway", () => {
    // gepetel: participantIds.some(id => BOT_PHONE_DIGITS.includes(String(id).replace(/\D/g,"")))
    const BOT_PHONE_DIGITS = ["40750271099", "279697464266959"];
    const emitted = toWhapiUserId("40750271099:3@s.whatsapp.net");
    assert.ok(BOT_PHONE_DIGITS.includes(String(emitted).replace(/\D/g, "")));
});

test("toWaJid accepts every shape gepetel sends as `to`", () => {
    assert.equal(toWaJid(GROUP), GROUP);
    assert.equal(toWaJid(USER), USER);
    assert.equal(toWaJid("40750271099"), USER); // CREATOR_PHONE / reminder phone
    assert.equal(toWaJid("40750271099@c.us"), USER);
    assert.equal(toWaJid(""), "");
    assert.equal(toWaJid(undefined), "");
});

test("LIDs are passed through unchanged, never mangled into fake phone numbers", () => {
    const lid = "123456789012345@lid";
    // Deliberate: a LID reaching toWhapiChatId is a bug upstream, and reshaping it
    // into <digits>@s.whatsapp.net would hide that bug behind wrong language
    // inference in gepetel.
    assert.equal(toWhapiChatId(lid), lid);
    assert.equal(looksLikePhoneNumber(lid), false);
    assert.equal(looksLikePhoneNumber(USER), true);
    assert.equal(looksLikePhoneNumber(GROUP), false);
});

test("isGroupJid distinguishes groups from DMs", () => {
    assert.equal(isGroupJid(GROUP), true);
    assert.equal(isGroupJid(USER), false);
    assert.equal(isGroupJid(undefined), false);
});

// ------------------------------------------------------------------ classify

test("plain conversation is text", () => {
    const c = classify({ conversation: "hello there" });
    assert.equal(c.kind, "text");
    assert.equal(c.text, "hello there");
});

test("extendedTextMessage with a body is text, not link_preview", () => {
    const c = classify({
        extendedTextMessage: { text: "look at this", matchedText: "https://x.com", title: "X" },
    });
    assert.equal(c.kind, "text");
    assert.equal(c.text, "look at this");
});

test("a bare link with no body becomes link_preview", () => {
    const c = classify({
        extendedTextMessage: { text: "", matchedText: "https://x.com", title: "X", description: "d" },
    });
    assert.equal(c.kind, "link_preview");
    assert.equal(c.preview.title, "X");
    assert.equal(c.preview.description, "d");
});

test("image carries its caption", () => {
    const c = classify({ imageMessage: { caption: "my dog" } });
    assert.equal(c.kind, "image");
    assert.equal(c.mediaKind, "image");
    assert.equal(c.caption, "my dog");
});

test("gifPlayback video is a gif; a normal video is skipped", () => {
    assert.equal(classify({ videoMessage: { gifPlayback: true } }).kind, "gif");
    // gepetel has no video branch — forwarding one would hit its `console.error`
    // + `continue` path on every video anyone posts.
    assert.equal(classify({ videoMessage: { gifPlayback: false } }).kind, "skip");
});

test("ptt audio is voice; non-ptt audio is audio", () => {
    assert.equal(classify({ audioMessage: { ptt: true } }).kind, "voice");
    assert.equal(classify({ audioMessage: { ptt: false } }).kind, "audio");
});

test("unsupported types are skipped rather than forwarded empty", () => {
    assert.equal(classify({ stickerMessage: {} }).kind, "skip");
    assert.equal(classify({ documentMessage: {} }).kind, "skip");
    assert.equal(classify({ reactionMessage: {} }).kind, "skip");
    assert.equal(classify({ protocolMessage: {} }).kind, "skip");
    assert.equal(classify(null).kind, "skip");
    assert.equal(classify(undefined).kind, "skip");
});

test("ephemeral and view-once wrappers are unwrapped", () => {
    assert.equal(classify({ ephemeralMessage: { message: { conversation: "hi" } } }).text, "hi");
    assert.equal(classify({ viewOnceMessageV2: { message: { imageMessage: {} } } }).kind, "image");
    // Nested wrappers (disappearing + view-once) resolve too.
    assert.equal(
        classify({ ephemeralMessage: { message: { viewOnceMessage: { message: { conversation: "deep" } } } } }).text,
        "deep"
    );
});

test("unwrap terminates on a self-referential wrapper instead of hanging", () => {
    const evil = {};
    evil.ephemeralMessage = { message: evil };
    // Must return, not spin. The value itself doesn't matter.
    const out = unwrap(evil);
    assert.ok(out);
});

// ------------------------------------------------------- buildWhapiMessage

const ids = {
    chatJid: GROUP,
    senderJid: USER,
    chatName: "Familia",
    senderName: "Bogdan",
};

test("a text message lands in gepetel's text branch", () => {
    const msg = buildWhapiMessage(
        { key: { id: "AAA", fromMe: false }, messageTimestamp: 1700000000 },
        classify({ conversation: "salut" }),
        ids
    );
    assert.equal(msg.id, "AAA");
    assert.equal(msg.from_me, false);
    assert.equal(msg.chat_id, GROUP);
    assert.equal(msg.chat_name, "Familia");
    assert.equal(msg.from, "40750271099");
    assert.equal(msg.from_name, "Bogdan");
    assert.deepEqual(gepetelBranch(msg), { branch: "text", value: "salut" });
});

test("an image message lands in gepetel's image branch and prefers the full-res link", () => {
    const msg = buildWhapiMessage(
        { key: { id: "BBB", fromMe: false } },
        classify({ imageMessage: { caption: "uite" } }),
        ids,
        { link: "https://gw/media/x.jpg", preview: "data:image/jpeg;base64,AAAA" }
    );
    const b = gepetelBranch(msg);
    assert.equal(b.branch, "image");
    // gepetel: const src = message.image.link || message.image.preview
    assert.equal(b.value, "https://gw/media/x.jpg");
    assert.equal(msg.image.caption, "uite");
});

test("an image with no thumbnail still exposes a preview, so gepetel's guard passes", () => {
    // gepetel's branch requires message.image.preview to be truthy. If we only set
    // `link`, the image would be silently dropped.
    const msg = buildWhapiMessage(
        { key: { id: "CCC" } },
        classify({ imageMessage: {} }),
        ids,
        { link: "https://gw/media/y.jpg" }
    );
    assert.ok(msg.image.preview, "image.preview must be set or gepetel ignores the message");
    assert.equal(gepetelBranch(msg).branch, "image");
});

test("a voice note lands in gepetel's voice branch with a fetchable link", () => {
    const msg = buildWhapiMessage(
        { key: { id: "DDD" } },
        classify({ audioMessage: { ptt: true } }),
        ids,
        { link: "https://gw/media/v.ogg" }
    );
    const b = gepetelBranch(msg);
    assert.equal(b.branch, "voice");
    // gepetel does an axios GET on this, so it must be an absolute URL.
    assert.ok(b.value.startsWith("https://"));
});

test("a gif lands in gepetel's gif branch", () => {
    const msg = buildWhapiMessage(
        { key: { id: "EEE" } },
        classify({ videoMessage: { gifPlayback: true, caption: "lol" } }),
        ids,
        { preview: "data:image/jpeg;base64,ZZZ" }
    );
    assert.equal(gepetelBranch(msg).branch, "gif");
    assert.equal(msg.gif.caption, "lol");
});

test("skipped classifications produce no payload at all", () => {
    assert.equal(buildWhapiMessage({ key: { id: "F" } }, classify({ stickerMessage: {} }), ids), null);
});

test("DM chat_name falls back to the sender's name", () => {
    const msg = buildWhapiMessage(
        { key: { id: "GGG" } },
        classify({ conversation: "hi" }),
        { chatJid: USER, senderJid: USER, senderName: "Bogdan" }
    );
    assert.equal(msg.chat_id, USER);
    assert.equal(msg.chat_name, "Bogdan");
    // Not a group id — gepetel's isGroup check keys off the @g.us suffix.
    assert.equal(GEPETEL_GROUP_RE.test(msg.chat_id), false);
});

test("a missing timestamp is filled rather than emitted as NaN", () => {
    const msg = buildWhapiMessage({ key: { id: "H" } }, classify({ conversation: "x" }), ids);
    assert.equal(typeof msg.timestamp, "number");
    assert.ok(Number.isFinite(msg.timestamp));
});

// --------------------------------------------------------------- group event

test("group events expose participants as bare digits", () => {
    const ev = buildWhapiGroupEvent(GROUP, "Familia", [
        { id: "40750271099@s.whatsapp.net", name: "Bogdan" },
        { id: "40711222333", name: "Ana" },
    ]);
    assert.equal(ev.id, GROUP);
    assert.equal(ev.name, "Familia");
    assert.deepEqual(ev.participants.map((p) => p.id), ["40750271099", "40711222333"]);
    // gepetel infers language from the +40 prefix on these.
    assert.ok(ev.participants.every((p) => p.id.startsWith("40")));
});

// ---------------------------------------------------------------- poll votes

test("poll updates match what gepetel's recordPollVotes reads", () => {
    const upd = buildWhapiPollUpdate(GROUP + "-poll1", GROUP, "Pizza sau shaorma?", [
        { name: "Pizza", voters: ["40750271099@s.whatsapp.net", "40711222333@s.whatsapp.net"] },
        { name: "Shaorma", voters: [] },
    ]);

    // gepetel: [upd.after_update, upd.message, upd].find(c => c && c.type === "poll"
    //          && c.poll && Array.isArray(c.poll.results))
    const found = [upd.after_update, upd.message, upd].find(
        (c) => c && c.type === "poll" && c.poll && Array.isArray(c.poll.results)
    );
    assert.ok(found, "gepetel must be able to locate the poll payload");

    assert.equal(found.poll.results[0].name, "Pizza");
    assert.equal(found.poll.results[0].count, 2);
    assert.deepEqual(found.poll.results[0].voters, ["40750271099", "40711222333"]);
    assert.equal(found.poll.results[1].count, 0);
    assert.equal(found.poll.total, 2);
});
