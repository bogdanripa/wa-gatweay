import { test } from "node:test";
import assert from "node:assert/strict";

import {
    decodeCursor,
    describeMessage,
    encodeCursor,
    foldForSearch,
    isConversationMessage,
    matchesQuery,
} from "../dist/chatlog.js";

/**
 * The MCP side's reading of messages. Nothing here is a consumer contract —
 * these are shapes for a model to read — so the tests pin behaviour, not
 * Meta's format.
 */

test("protocol traffic, reactions and poll votes are not conversation", () => {
    assert.equal(isConversationMessage({ protocolMessage: { type: 0 } }), false);
    assert.equal(isConversationMessage({ reactionMessage: { text: "👍", key: { id: "X" } } }), false);
    assert.equal(isConversationMessage({ pollUpdateMessage: {} }), false);
    assert.equal(isConversationMessage({ senderKeyDistributionMessage: {}, messageContextInfo: {} }), false);
    assert.equal(isConversationMessage(undefined), false);
});

test("text, media and wrapped messages are conversation", () => {
    assert.equal(isConversationMessage({ conversation: "hi" }), true);
    assert.equal(isConversationMessage({ imageMessage: {}, messageContextInfo: {} }), true);
    assert.equal(isConversationMessage({ ephemeralMessage: { message: { extendedTextMessage: { text: "x" } } } }), true);
    assert.equal(isConversationMessage({ stickerMessage: {} }), true);
});

test("describeMessage reads text, captions, files and quotes", () => {
    assert.deepEqual(describeMessage({ conversation: "salut" }), { type: "text", text: "salut" });
    assert.deepEqual(
        describeMessage({ extendedTextMessage: { text: "da", contextInfo: { stanzaId: "Q1", participant: "1@s.whatsapp.net" } } }),
        { type: "text", text: "da", replyTo: "Q1" }
    );
    const img = describeMessage({ imageMessage: { caption: "la mare", mimetype: "image/jpeg" } });
    assert.equal(img.type, "image");
    assert.equal(img.text, "la mare");
    assert.equal(img.media, true);
    const doc = describeMessage({ documentMessage: { fileName: "factura.pdf", mimetype: "application/pdf" } });
    assert.equal(doc.type, "document");
    assert.equal(doc.filename, "factura.pdf");
});

test("describeMessage names what classify skips, instead of dropping it", () => {
    assert.equal(describeMessage({ stickerMessage: {} }).type, "sticker");
    assert.equal(describeMessage({ videoMessage: { caption: "v" } }).type, "video");
    const loc = describeMessage({ locationMessage: { degreesLatitude: 44.4, degreesLongitude: 26.1, name: "Acasă" } });
    assert.equal(loc.type, "location");
    assert.match(loc.text, /Acasă 44.4,26.1/);
    const poll = describeMessage({ pollCreationMessageV3: { name: "Când?", options: [{ optionName: "Luni" }, { optionName: "Marți" }] } });
    assert.equal(poll.type, "poll");
    assert.match(poll.text, /Când\?\n- Luni\n- Marți/);
    assert.deepEqual(describeMessage({ reactionMessage: { key: { id: "M1" }, text: "❤️" } }), {
        type: "reaction",
        reaction: { messageId: "M1", emoji: "❤️" },
    });
});

test("search folds case and diacritics, and needs every term", () => {
    assert.equal(foldForSearch("Ședință MÂINE"), "sedinta maine");
    assert.equal(matchesQuery("Ședința de mâine e la 10", "sedinta maine"), true);
    assert.equal(matchesQuery("Ședința de mâine", "sedinta vineri"), false);
    assert.equal(matchesQuery("anything", "   "), false);
    assert.equal(matchesQuery(undefined, "x"), false);
});

test("a cursor round-trips the whole anchor, and garbage decodes to null", () => {
    const a = { id: "3EB0ABC", fromMe: false, participant: "123@lid", remoteJid: "120363@g.us", at: 1763560000000 };
    assert.deepEqual(decodeCursor(encodeCursor(a)), a);
    const mine = { id: "X", fromMe: true, remoteJid: "40722@s.whatsapp.net", at: 1 };
    assert.deepEqual(decodeCursor(encodeCursor(mine)), { ...mine, participant: undefined });
    assert.equal(decodeCursor("not-a-cursor"), null);
    assert.equal(decodeCursor(Buffer.from('["x"]').toString("base64url")), null);
});
