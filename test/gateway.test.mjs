import { test } from "node:test";
import assert from "node:assert/strict";

import {
    digitsOf,
    preferPhoneNumber,
    rewriteMentions,
    isGroupJid,
    looksLikePhoneNumber,
    stripDevice,
    toWaJid,
    toChatId,
    toUserId,
} from "../dist/jid.js";
import { classify, mentionedJidsOf, quotedContextOf, unwrap } from "../dist/map.js";
import {
    buildCloudGroupEvent,
    buildCloudMessageEvent,
    buildCloudPollVoteEvent,
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
        { chatJid: GROUP, senderJid: USER, chatName: "Team", senderName: "Alex Doe" },
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
    const event = buildCloudGroupEvent(GROUP, "Team", [{ id: USER, name: "Alex Doe" }], CLOUD_META);
    assert.equal(event.entry[0].changes[0].field, "group_participants_update");
    const group = event.entry[0].changes[0].value.groups[0];
    assert.equal(group.group_id, GROUP);
    assert.equal(group.subject, "Team");
    // `lid` is additive and null when unknown — a participant whose LID has not
    // been seen still appears, rather than being withheld.
    assert.deepEqual(group.participants, [
        { wa_id: "12025550100", lid: null, name: "Alex Doe" },
    ]);
});

/**
 * Polls, which Meta's Cloud API cannot send at all.
 *
 * There is no official shape to match, so these assert the one we publish —
 * `selectable_count` is WhatsApp's own wire field (`selectableOptionsCount`),
 * and Baileys sends a single-select poll for exactly 1 and a multiple-choice
 * one otherwise. That mapping is the whole contract.
 */
test("the documented poll body parses", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp",
        recipient_type: "group",
        to: GROUP,
        type: "poll",
        poll: { name: "Birou?", options: ["Da", "Nu"], selectable_count: 1 },
    });
    assert.equal(req.recipientType, "group");
    assert.deepEqual(req.kind, {
        type: "poll",
        name: "Birou?",
        options: ["Da", "Nu"],
        selectableCount: 1,
    });
});

test("selectable_count passes through verbatim — pick up to 2 of 5", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["a","b","c","d","e"], selectable_count: 2 },
    });
    // Neither Meta nor an inverted 0-means-unlimited convention can express this.
    assert.equal(req.kind.selectableCount, 2);
});

test("a poll defaults to single-answer", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["A", "B"] },
    });
    assert.equal(req.kind.selectableCount, 1);
});

test("allow_multiple_answers means as many as there are", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["A", "B", "C"], allow_multiple_answers: true },
    });
    assert.equal(req.kind.selectableCount, 3);
});

test("selectable_count wins over the convenience boolean", () => {
    const req = parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["A","B","C"], selectable_count: 2, allow_multiple_answers: true },
    });
    assert.equal(req.kind.selectableCount, 2);
});

test("selectable_count of 0 is refused, not read as unlimited", () => {
    // The inverted convention other APIs use. Accepting it silently would make
    // "unset" and "unlimited" the same value.
    assert.throws(() => parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["A", "B"], selectable_count: 0 },
    }), /selectable_count/);
});

test("selectable_count above the option count is refused", () => {
    assert.throws(() => parseCloudSendRequest({
        messaging_product: "whatsapp", to: "1", type: "poll",
        poll: { name: "Pick", options: ["A", "B"], selectable_count: 5 },
    }), /selectable_count/);
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

// ---------------------------------------------------------------------- mentions
//
// A LID leaking into the message *body*. WhatsApp writes only the JID's user
// part into the text, so a mention in a LID-addressed group reads
// "@81656102801535" — digits that look exactly like a phone number downstream.

const MENTION_LID = "81656102801535@lid";

test("mentions come from contextInfo, not from the text", () => {
    assert.deepEqual(
        mentionedJidsOf({
            extendedTextMessage: {
                text: "@81656102801535 pe la cat plecati?",
                contextInfo: { mentionedJid: [MENTION_LID] },
            },
        }),
        [MENTION_LID]
    );
});

test("mentions are found on media messages too, not just text", () => {
    assert.deepEqual(
        mentionedJidsOf({ imageMessage: { caption: "@1 hi", contextInfo: { mentionedJid: [MENTION_LID] } } }),
        [MENTION_LID]
    );
});

test("a message with no mentions yields none", () => {
    assert.deepEqual(mentionedJidsOf({ conversation: "no mentions here" }), []);
    assert.deepEqual(mentionedJidsOf(null), []);
});

test("a mentioned LID is rewritten to the phone number", () => {
    const mapping = new Map([["81656102801535", "12025550100"]]);
    assert.equal(
        rewriteMentions("@81656102801535 pe la cat plecati?", mapping),
        "@12025550100 pe la cat plecati?"
    );
});

test("several mentions in one message are all rewritten", () => {
    const mapping = new Map([["81656102801535", "12025550100"], ["99900011122233", "12025550142"]]);
    assert.equal(
        rewriteMentions("@81656102801535 and @99900011122233 both", mapping),
        "@12025550100 and @12025550142 both"
    );
});

test("a number someone typed by hand is never touched", () => {
    // The reason the mapping comes from mentionedJid and not a regex: this text
    // contains a bare @-number that WhatsApp did not report as a mention.
    const mapping = new Map([["81656102801535", "12025550100"]]);
    assert.equal(
        rewriteMentions("call @40712345678 or @81656102801535", mapping),
        "call @40712345678 or @12025550100"
    );
});

test("an unresolvable mention is left visible rather than reshaped", () => {
    // Same rule as toChatId: a LID nobody could resolve stays a LID, so the bug
    // is visible instead of masquerading as a phone number.
    assert.equal(rewriteMentions("@81656102801535 hi", new Map()), "@81656102801535 hi");
});

test("rewriting copes with no text at all", () => {
    assert.equal(rewriteMentions(undefined, new Map([["1", "2"]])), undefined);
    assert.equal(rewriteMentions("", new Map([["1", "2"]])), "");
});

// ----------------------------------------------------------------- reply context
//
// Meta's own shape for a reply: `context: { from, id }` on the message, present
// only when the message actually quotes another. Strictly additive — a message
// that replies to nothing must look exactly as it did before.

const QUOTED_ID = "3EB0AAAABBBBCCCC";
const BOT_NUMBER = "12025550199@s.whatsapp.net";

const withContext = (message, ids = {}) =>
    buildCloudMessageEvent(
        { key: { id: "wamid.R", remoteJid: GROUP, participant: USER }, messageTimestamp: 1 },
        classify(message),
        { chatJid: GROUP, senderJid: USER, ...ids },
        CLOUD_META
    ).entry[0].changes[0].value.messages[0];

test("a reply to a text message carries context", () => {
    const q = quotedContextOf({
        extendedTextMessage: {
            text: "da, ok",
            contextInfo: { stanzaId: QUOTED_ID, participant: USER },
        },
    });
    assert.deepEqual(q, { id: QUOTED_ID, participant: USER });
});

test("a reply to a photo carries context — not text-only", () => {
    const q = quotedContextOf({
        imageMessage: { caption: "asta", contextInfo: { stanzaId: QUOTED_ID, participant: USER } },
    });
    assert.equal(q.id, QUOTED_ID);
});

test("a reply to a voice note carries context", () => {
    const q = quotedContextOf({
        audioMessage: { ptt: true, contextInfo: { stanzaId: QUOTED_ID, participant: USER } },
    });
    assert.equal(q.id, QUOTED_ID);
});

test("a reply to a message the gateway itself sent is reported like any other", () => {
    // The bot's own number is a perfectly good `from`; suppressing it would hide
    // exactly the case a bot most wants to notice.
    const q = quotedContextOf({
        extendedTextMessage: { text: "ok", contextInfo: { stanzaId: QUOTED_ID, participant: BOT_NUMBER } },
    });
    assert.deepEqual(q, { id: QUOTED_ID, participant: BOT_NUMBER });
});

test("a message that replies to nothing has no context at all", () => {
    assert.equal(quotedContextOf({ conversation: "plain" }), undefined);
    // contextInfo exists for mentions too — its presence alone is not a reply.
    assert.equal(
        quotedContextOf({
            extendedTextMessage: { text: "@1 hi", contextInfo: { mentionedJid: ["1@lid"] } },
        }),
        undefined
    );
});

test("context reaches the webhook payload, in Meta's shape", () => {
    const msg = withContext(
        { extendedTextMessage: { text: "da", contextInfo: { stanzaId: QUOTED_ID, participant: USER } } },
        { context: { id: QUOTED_ID, from: "12025550100" } }
    );
    assert.deepEqual(msg.context, { id: QUOTED_ID, from: "12025550100" });
});

test("context rides on media messages too", () => {
    const msg = withContext(
        { imageMessage: { caption: "x", contextInfo: { stanzaId: QUOTED_ID, participant: USER } } },
        { context: { id: QUOTED_ID, from: "12025550100" } }
    );
    assert.equal(msg.type, "image");
    assert.deepEqual(msg.context, { id: QUOTED_ID, from: "12025550100" });
});

test("the payload is unchanged when the message is not a reply", () => {
    // The additive guarantee, asserted rather than assumed.
    const msg = withContext({ conversation: "plain" });
    assert.ok(!("context" in msg));
    assert.deepEqual(Object.keys(msg).sort(), ["from", "group_id", "id", "text", "timestamp", "type"]);
});

// ------------------------------------------------------------------ poll votes
//
// Meta's Cloud API cannot do polls in either direction, so there is no official
// shape. This follows how Meta models button_reply/list_reply: the response is
// an inbound `interactive` message whose `context` points at what it responds
// to — which is exactly the join key a tally needs.

const POLL_MSG_ID = "3EB0POLL0001";
const BOT_DIGITS = "12025550199";

const voteEvent = (over = {}) =>
    buildCloudPollVoteEvent(
        {
            id: "3EB0VOTE0001",
            from: "12025550100",
            voterName: "Ana",
            timestamp: 1755870000,
            pollMessageId: POLL_MSG_ID,
            pollFrom: BOT_DIGITS,
            groupJid: GROUP,
            selected: [{ id: "0", title: "Pizza" }],
            results: [
                { id: "0", title: "Pizza", count: 1, voters: ["12025550100"] },
                { id: "1", title: "Sushi", count: 0, voters: [] },
            ],
            ...over,
        },
        CLOUD_META
    ).entry[0].changes[0].value;

test("a vote is an interactive message of type poll_response", () => {
    const msg = voteEvent().messages[0];
    assert.equal(msg.type, "interactive");
    assert.equal(msg.interactive.type, "poll_response");
});

test("context.id is the POLL's message id, not the vote's", () => {
    // The single easiest thing to get wrong, and the field a tally joins on.
    const msg = voteEvent().messages[0];
    assert.equal(msg.context.id, POLL_MSG_ID);
    assert.notEqual(msg.context.id, msg.id);
    assert.equal(msg.context.from, BOT_DIGITS);
});

test("the voter is in `from`, with their profile name in contacts", () => {
    const value = voteEvent();
    assert.equal(value.messages[0].from, "12025550100");
    assert.deepEqual(value.contacts, [{ profile: { name: "Ana" }, wa_id: "12025550100" }]);
});

test("selected_options is the full current choice, and total sums the results", () => {
    const r = voteEvent().messages[0].interactive.poll_response;
    assert.deepEqual(r.selected_options, [{ id: "0", title: "Pizza" }]);
    assert.equal(r.total, 1);
});

test("a multi-select vote lists every chosen option", () => {
    const r = voteEvent({
        selected: [{ id: "0", title: "Pizza" }, { id: "1", title: "Sushi" }],
        results: [
            { id: "0", title: "Pizza", count: 1, voters: ["12025550100"] },
            { id: "1", title: "Sushi", count: 1, voters: ["12025550100"] },
        ],
    }).messages[0].interactive.poll_response;
    assert.equal(r.selected_options.length, 2);
    assert.equal(r.total, 2);
});

test("clearing a vote sends an empty selection and the counts drop", () => {
    const r = voteEvent({
        selected: [],
        results: [
            { id: "0", title: "Pizza", count: 0, voters: [] },
            { id: "1", title: "Sushi", count: 0, voters: [] },
        ],
    }).messages[0].interactive.poll_response;
    assert.deepEqual(r.selected_options, []);
    assert.equal(r.total, 0);
});

test("results carry every option, including ones nobody picked", () => {
    // A consumer rendering a tally needs the zeroes as much as the counts.
    const r = voteEvent().messages[0].interactive.poll_response;
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results.map((o) => o.id), ["0", "1"]);
    assert.equal(r.results[1].count, 0);
});

test("a group vote carries group_id; a DM vote carries none", () => {
    assert.equal(voteEvent().messages[0].group_id, GROUP);
    assert.ok(!("group_id" in voteEvent({ groupJid: undefined }).messages[0]));
});

test("a vote sits in the same envelope as every other event", () => {
    const event = buildCloudPollVoteEvent(
        {
            id: "v", from: "1", timestamp: 1, pollMessageId: POLL_MSG_ID,
            pollFrom: BOT_DIGITS, selected: [], results: [],
        },
        CLOUD_META
    );
    assert.equal(event.object, "whatsapp_business_account");
    assert.equal(event.entry[0].changes[0].field, "messages");
    assert.equal(event.entry[0].changes[0].value.metadata.phone_number_id, CLOUD_META.phoneNumberId);
});

// -------------------------------------------------------------- mention identity
//
// LID is WhatsApp's canonical id going forward and phone numbers are what the
// migration removes, so both are carried and neither is ever dropped.

test("a resolved mention carries both ids", () => {
    const msg = withContext(
        { extendedTextMessage: { text: "@12025550100 hi" } },
        { mentions: [{ lid: "81656102801535", phone: "12025550100" }] }
    );
    assert.deepEqual(msg.mentions, [{ lid: "81656102801535", phone: "12025550100" }]);
});

test("an unresolved mention still carries the LID, with phone null", () => {
    // The case that matters: someone who has never spoken, so the mapping has
    // never seen them. Null is a normal answer, not an error.
    const msg = withContext(
        { extendedTextMessage: { text: "@99887766554433 hi" } },
        { mentions: [{ lid: "99887766554433", phone: null }] }
    );
    assert.deepEqual(msg.mentions, [{ lid: "99887766554433", phone: null }]);
    // And the body keeps the raw LID rather than losing the mention.
    assert.match(msg.text.body, /@99887766554433/);
});

test("a message with no mentions carries no mentions key", () => {
    assert.ok(!("mentions" in withContext({ conversation: "plain" })));
});

test("the sender's LID rides alongside the phone number in from", () => {
    const msg = withContext({ conversation: "hi" }, { senderLid: "81656102801535" });
    assert.equal(msg.from, "12025550100");
    assert.equal(msg.from_lid, "81656102801535");
});

test("group participants carry both ids too", () => {
    const group = buildCloudGroupEvent(
        GROUP,
        "Team",
        [
            { id: USER, lid: "81656102801535", name: "Alex Doe" },
            { id: "12025550142@s.whatsapp.net", lid: null, name: "Sam" },
        ],
        CLOUD_META
    ).entry[0].changes[0].value.groups[0];
    assert.deepEqual(group.participants, [
        { wa_id: "12025550100", lid: "81656102801535", name: "Alex Doe" },
        { wa_id: "12025550142", lid: null, name: "Sam" },
    ]);
});

test("an unresolved mention is never rewritten into a fake number", () => {
    // rewriteMentions only touches tokens the caller mapped, and an unresolved
    // mention is never added to that mapping.
    assert.equal(
        rewriteMentions("@99887766554433 hi", new Map([["81656102801535", "12025550100"]])),
        "@99887766554433 hi"
    );
});
