import { test } from "node:test";
import assert from "node:assert/strict";

import {
    digitsOf,
    preferPhoneNumber,
    isGroupJid,
    looksLikePhoneNumber,
    stripDevice,
    toWaJid,
    toChatId,
    toUserId,
} from "../dist/jid.js";
import { classify, unwrap } from "../dist/map.js";
import {
    buildCloudGroupEvent,
    buildCloudMessageEvent,
    buildCloudSendResponse,
    parseCloudSendRequest,
} from "../dist/cloud.js";

const GROUP = "120363012345678901@g.us";
const USER = "12025550100@s.whatsapp.net";

/**
 * A real LID seen in production. Its digits are not a phone number, but nothing
 * downstream can tell — which is the whole reason the resolution path exists.
 */
const LID = "139556506575001@lid";
const PN = "12025550100@s.whatsapp.net";

/**
 * The shape a group id has to keep. Consumers commonly guard on something like
 * this before treating a chat as a group, so emitting anything else means the
 * group silently reads as a DM.
 */
const GROUP_ID_RE = /^[\d-]{10,31}@g\.us$/;


// ---------------------------------------------------------------------- jid

test("group jids keep the shape consumers guard on", () => {
    const chatId = toChatId(GROUP);
    assert.equal(chatId, GROUP);
    assert.ok(GROUP_ID_RE.test(chatId), `${chatId} must still read as a group id`);
});

test("legacy dashed group ids also match", () => {
    const legacy = "120363012345678-1234567890@g.us";
    assert.ok(GROUP_ID_RE.test(toChatId(legacy)));
});

test("user jids normalise to <digits>@s.whatsapp.net", () => {
    assert.equal(toChatId(USER), USER);
    assert.equal(toChatId("12025550100"), USER);
});

test("device suffixes are stripped (Baileys sends 4075...:12@s.whatsapp.net)", () => {
    assert.equal(stripDevice("12025550100:12@s.whatsapp.net"), USER);
    assert.equal(toChatId("12025550100:12@s.whatsapp.net"), USER);
    assert.equal(toUserId("12025550100:12@s.whatsapp.net"), "12025550100");
});

test("digitsOf matches String(x).replace(/\\D/g,'') exactly", () => {
    for (const input of [USER, "12025550100", "+40 750 271 099", GROUP]) {
        assert.equal(digitsOf(input), String(input).replace(/\D/g, "").replace(/@.*/, ""));
    }
});

test("a bot can still recognise its own number among participants", () => {
    // The common pattern: participants.some(id => MY_DIGITS.includes(digitsOf(id)))
    const BOT_PHONE_DIGITS = ["12025550100", "279697464266959"];
    const emitted = toUserId("12025550100:3@s.whatsapp.net");
    assert.ok(BOT_PHONE_DIGITS.includes(String(emitted).replace(/\D/g, "")));
});

test("toWaJid accepts every shape a caller sends as `to`", () => {
    assert.equal(toWaJid(GROUP), GROUP);
    assert.equal(toWaJid(USER), USER);
    assert.equal(toWaJid("12025550100"), USER); // CREATOR_PHONE / reminder phone
    assert.equal(toWaJid("12025550100@c.us"), USER);
    assert.equal(toWaJid(""), "");
    assert.equal(toWaJid(undefined), "");
});

test("LIDs are passed through unchanged, never mangled into fake phone numbers", () => {
    const lid = "123456789012345@lid";
    // Deliberate: a LID reaching toChatId is a bug upstream, and reshaping
    // it into <digits>@s.whatsapp.net would hide that bug behind wrong country
    // inference downstream.
    assert.equal(toChatId(lid), lid);
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
    // There is no video payload shape, so forwarding one would only make a
    // consumer log and discard it — on every video anyone posts.
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

test("a LID resolves to the phone-number form shipped beside it", () => {
    assert.equal(preferPhoneNumber(LID, PN), PN);
});

test("digits of an unresolved LID are indistinguishable from a phone number", () => {
    // Why the alt matters at all: nothing downstream can tell these apart.
    assert.equal(digitsOf(LID), "139556506575001");
    assert.ok(/^\d+$/.test(digitsOf(LID)));
});

test("a non-LID jid is left alone — there is nothing to resolve", () => {
    assert.equal(preferPhoneNumber(PN, "12025550142@s.whatsapp.net"), null);
});

test("a LID whose alt is also a LID resolves to nothing", () => {
    // Better to fall through to the mapping store and then warn than to emit
    // a second LID as though it were a number.
    assert.equal(preferPhoneNumber(LID, "987654321098765@lid"), null);
});

test("a missing or empty alt resolves to nothing", () => {
    assert.equal(preferPhoneNumber(LID, undefined), null);
    assert.equal(preferPhoneNumber(LID, ""), null);
    assert.equal(preferPhoneNumber(LID, null), null);
});

test("a group jid is never offered as a sender's phone number", () => {
    assert.equal(preferPhoneNumber(LID, GROUP), null);
});

test("an alt too long to be E.164 is refused", () => {
    // 16 digits — a LID that lost its @lid suffix would land here.
    assert.equal(preferPhoneNumber(LID, "1234567890123456@s.whatsapp.net"), null);
});

test("a resolved sender comes out as real phone digits", () => {
    const resolved = preferPhoneNumber(LID, PN) ?? LID;
    assert.equal(toUserId(resolved), "12025550100");
    // And the calling-code prefix a consumer keys off is now the right one:
    // "1" (US), not the "139…" of the LID it came from.
    assert.ok(toUserId(resolved).startsWith("1202"));
});

// ---------------------------------------------------------------------------
// WhatsApp Cloud API compatibility.
//
// These assert against shapes taken from Meta's own documentation, not against
// this code — the whole promise is that a client written for the Cloud API
// keeps working after a base-URL change, and only Meta's shapes can prove that.

const CLOUD_META = {
    displayPhoneNumber: "12025550199",
    phoneNumberId: "100000000000000",
    businessAccountId: "102290129340398",
};

test("Meta's documented text body parses", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "+16505551234",
        type: "text",
        text: { preview_url: true, body: "Does it come in another color?" },
    });
    assert.equal(req.to, "+16505551234");
    assert.equal(req.recipientType, "individual");
    assert.deepEqual(req.kind, {
        type: "text",
        body: "Does it come in another color?",
        previewUrl: true,
    });
});

test("recipient_type group is carried through", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp",
        recipient_type: "group",
        to: GROUP,
        type: "text",
        text: { body: "hi" },
    });
    assert.equal(req.recipientType, "group");
});

test("a wrong messaging_product is refused, as Meta refuses it", () => {
    assert.throws(
        () => parseCloudSendRequest({ to: "1", type: "text", text: { body: "x" } }),
        /messaging_product/
    );
});

test("mark-as-read carries no recipient", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.HBgL",
    });
    assert.deepEqual(req.kind, { type: "read", messageId: "wamid.HBgL", typing: false });
});

test("a typing indicator rides along with the read receipt, as Meta models it", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.HBgL",
        typing_indicator: { type: "text" },
    });
    assert.equal(req.kind.typing, true);
});

test("media accepts link or id", () => {
    assert.equal(
        parseCloudSendRequest({
            messaging_product: "whatsapp", to: "1", type: "image",
            image: { link: "https://x/cat.png", caption: "c" },
        }).kind.media,
        "https://x/cat.png"
    );
    assert.equal(
        parseCloudSendRequest({
            messaging_product: "whatsapp", to: "1", type: "image", image: { id: "123" },
        }).kind.media,
        "123"
    );
});

test("the send response matches Meta's envelope", () => {
    const res = buildCloudSendResponse("+16505551234", "16505551234", "wamid.X");
    assert.deepEqual(res, {
        messaging_product: "whatsapp",
        contacts: [{ input: "+16505551234", wa_id: "16505551234" }],
        messages: [{ id: "wamid.X" }],
    });
});

test("an inbound DM matches Meta's webhook nesting exactly", () => {
    const event = buildCloudMessageEvent(
        { key: { id: "wamid.ABC", remoteJid: USER }, messageTimestamp: 1749416383 },
        { kind: "text", text: "Hello" },
        { chatJid: USER, senderJid: USER, senderName: "Sheena Nelson" },
        CLOUD_META
    );
    assert.equal(event.object, "whatsapp_business_account");
    assert.equal(event.entry[0].id, CLOUD_META.businessAccountId);
    const change = event.entry[0].changes[0];
    assert.equal(change.field, "messages");
    assert.equal(change.value.messaging_product, "whatsapp");
    assert.deepEqual(change.value.metadata, {
        display_phone_number: "12025550199",
        phone_number_id: "100000000000000",
    });
    assert.deepEqual(change.value.contacts, [
        { profile: { name: "Sheena Nelson" }, wa_id: "12025550100" },
    ]);
    const msg = change.value.messages[0];
    assert.deepEqual(msg, {
        from: "12025550100",
        id: "wamid.ABC",
        // Meta sends the timestamp as a STRING; clients parse it as one.
        timestamp: "1749416383",
        type: "text",
        text: { body: "Hello" },
    });
});

test("a group message carries group_id, with the participant in from", () => {
    const event = buildCloudMessageEvent(
        { key: { id: "wamid.G", remoteJid: GROUP, participant: USER }, messageTimestamp: 1 },
        { kind: "text", text: "yo" },
        { chatJid: GROUP, senderJid: USER, chatName: "Team", senderName: "Bogdan" },
        CLOUD_META
    );
    const msg = event.entry[0].changes[0].value.messages[0];
    assert.equal(msg.group_id, GROUP);
    assert.equal(msg.from, "12025550100");
});

test("a DM has no group_id at all, rather than a null one", () => {
    const event = buildCloudMessageEvent(
        { key: { id: "m", remoteJid: USER }, messageTimestamp: 1 },
        { kind: "text", text: "x" },
        { chatJid: USER, senderJid: USER },
        CLOUD_META
    );
    assert.ok(!("group_id" in event.entry[0].changes[0].value.messages[0]));
});

test("a voice note is an audio message flagged voice, as Meta types it", () => {
    const event = buildCloudMessageEvent(
        { key: { id: "m", remoteJid: USER }, messageTimestamp: 1 },
        { kind: "voice", mediaKind: "voice" },
        { chatJid: USER, senderJid: USER },
        CLOUD_META,
        { link: "https://x/a.ogg" }
    );
    const msg = event.entry[0].changes[0].value.messages[0];
    assert.equal(msg.type, "audio");
    assert.equal(msg.audio.voice, true);
    assert.equal(msg.audio.link, "https://x/a.ogg");
});

test("a GIF becomes a video, because Meta has no gif type", () => {
    const event = buildCloudMessageEvent(
        { key: { id: "m", remoteJid: USER }, messageTimestamp: 1 },
        { kind: "gif", mediaKind: "gif", caption: "lol" },
        { chatJid: USER, senderJid: USER },
        CLOUD_META,
        { link: "https://x/g.mp4" }
    );
    assert.equal(event.entry[0].changes[0].value.messages[0].type, "video");
});

test("skipped classifications produce no cloud event either", () => {
    assert.equal(
        buildCloudMessageEvent({ key: {} }, { kind: "skip" }, { chatJid: USER, senderJid: USER }, CLOUD_META),
        null
    );
});

test("group participant events use Meta's group_participants_update field", () => {
    const event = buildCloudGroupEvent(GROUP, "Team", [{ id: USER, name: "Bogdan" }], CLOUD_META);
    assert.equal(event.entry[0].changes[0].field, "group_participants_update");
    const group = event.entry[0].changes[0].value.groups[0];
    assert.equal(group.group_id, GROUP);
    assert.equal(group.subject, "Team");
    assert.deepEqual(group.participants, [{ wa_id: "12025550100", name: "Bogdan" }]);
});

test("a poll is sendable through the Cloud shape, which Meta has no type for", () => {
    // Meta cannot send a poll at all. WhatsApp can, so refusing to express it
    // would mean adopting the Cloud shape silently costs you polls — which is
    // exactly what happened: a bot fell back to posting a numbered list as text.
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp",
        recipient_type: "group",
        to: GROUP,
        type: "poll",
        poll: { name: "Lunch?", options: ["Pizza", "Sushi"], allow_multiple_answers: true },
    });
    assert.equal(req.recipientType, "group");
    assert.deepEqual(req.kind, {
        type: "poll",
        name: "Lunch?",
        options: ["Pizza", "Sushi"],
        allowMultiple: true,
    });
});

test("allow_multiple_answers defaults to false, as a single-choice poll", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["A", "B"] },
    });
    assert.equal(req.kind.allowMultiple, false);
});

test("a one-option poll is refused rather than sent as something else", () => {
    assert.throws(() => parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["only-one"] },
    }), /poll/);
});

test("blank poll options are dropped before the two-option check", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["A", "  ", "B", ""] },
    });
    assert.deepEqual(req.kind.options, ["A", "B"]);
});

test("the unsupported-type error names poll as available", () => {
    try {
        parseCloudSendRequest({ messaging_product: "whatsapp", to: "1", type: "interactive" });
        assert.fail("should have thrown");
    } catch (e) {
        assert.match(e.details, /poll/);
    }
});
