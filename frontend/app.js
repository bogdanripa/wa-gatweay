/**
 * wa-gateway management console.
 *
 * The gateway lives at /api on this same origin, so the key never leaves the
 * page's own host and there is no CORS involved. It is held in localStorage
 * because the alternative — a cookie — would be sent automatically on every
 * request to the origin, including the media URLs the gateway hands to OpenAI.
 */

const KEY_STORAGE = "wa-gateway:key";
const API = "/api/mgmt";

/** Statuses that mean a QR or pairing code is worth watching for. */
const PAIRING_STATES = new Set(["awaiting-pairing", "starting", "connecting"]);

let key = localStorage.getItem(KEY_STORAGE) || "";
let pollTimer = null;
/** Id of the card currently being edited. Polling pauses so it can't be redrawn. */
let editingId = null;

const $ = (sel) => document.querySelector(sel);

/** "3 minutes ago", "2 days ago". Returns null for a missing timestamp. */
function timeAgo(iso) {
    if (!iso) return null;
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 45) return "just now";
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    const units = [
        ["year", 31536000],
        ["month", 2592000],
        ["week", 604800],
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
    ];
    for (const [unit, size] of units) {
        if (seconds >= size) return rtf.format(-Math.round(seconds / size), unit);
    }
    return "just now";
}

/** "from Alex Doe in Team lunch" — whatever of that we actually know. */
function describeSender(m) {
    const who = m.fromName || m.from || "someone";
    if (m.isGroup && m.chatName) return `from ${who} in ${m.chatName}`;
    if (m.isGroup) return `from ${who} in a group`;
    return `from ${who}`;
}

/**
 * Build an element. Everything user-supplied goes in as `text`, never as HTML —
 * ids and webhook URLs are operator input, and this page shows bot tokens.
 */
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "text") node.textContent = v;
        else if (k === "class") node.className = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
        if (c === undefined || c === null || c === false) continue;
        node.append(c);
    }
    return node;
}

/** Thrown after the key is rejected; callers stay quiet and let lock() show the form. */
const LOCKED = Symbol("locked");

async function api(path, options = {}) {
    const res = await fetch(API + path, {
        ...options,
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            ...(options.headers || {}),
        },
    });

    if (res.status === 401) {
        lock();
        throw LOCKED;
    }

    // The gateway is up but has no management key yet — a fresh deployment
    // before anyone set the environment variables. Say that, rather than
    // letting it read as a wrong key.
    if (res.status === 503) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error?.message || "the gateway is not configured yet");
    }

    const body = await res.text();
    const data = body ? JSON.parse(body) : {};
    if (!res.ok) throw new Error(data?.error?.message || `request failed (${res.status})`);
    return data;
}

// --- screens ---------------------------------------------------------------

function lock() {
    stopPolling();
    key = "";
    localStorage.removeItem(KEY_STORAGE);
    $("#console").hidden = true;
    $("#lock").hidden = true;
    $("#summary").textContent = "";
    $("#unlock").hidden = false;
    $("#key").value = "";
    $("#key").focus();
}

function unlocked() {
    $("#unlock").hidden = true;
    $("#unlock-error").hidden = true;
    $("#console").hidden = false;
    $("#lock").hidden = false;
}

// --- rendering -------------------------------------------------------------

function kv(label, value, extra) {
    return el("div", { class: "kv" },
        el("span", { class: "k", text: label }),
        typeof value === "string" ? el("span", { class: "v", text: value }) : value,
        extra
    );
}

function pairingBlock(n) {
    if (n.status === "connected") return null;

    if (n.qrDataUrl) {
        return el("div", { class: "pairing" },
            el("p", { class: "muted", text: "WhatsApp → Settings → Linked devices → Link a device" }),
            el("img", { src: n.qrDataUrl, alt: `Pairing QR for ${n.id}`, width: "320", height: "320" }),
            el("p", { class: "muted", text: "The code rotates every few seconds; this page keeps up." })
        );
    }

    if (n.pairingCode) {
        return el("div", { class: "pairing" },
            el("p", { class: "muted", text: "WhatsApp → Linked devices → Link with phone number" }),
            el("span", { class: "pair-code", text: n.pairingCode })
        );
    }

    if (PAIRING_STATES.has(n.status)) {
        return el("div", { class: "pairing" },
            el("p", { class: "muted", text: "Waiting for WhatsApp to hand out a pairing code…" })
        );
    }

    return null;
}

function statusNote(n) {
    if (n.status === "conflict") {
        return el("div", { class: "warn-box" },
            el("strong", { text: "Another client is using these credentials. " }),
            "This session stopped rather than fight for the device slot — two clients on one number end in a logout. " +
            "Check for a second gateway instance, then restart it below."
        );
    }
    if (n.status === "logged-out") {
        return el("div", { class: "warn-box" },
            el("strong", { text: "Unlinked from WhatsApp. " }),
            "Its credentials were wiped. Use “Unlink & re-pair” to get a fresh QR."
        );
    }
    // A webhook that rejects every delivery is invisible from the outside: the
    // number reads "connected", the bot receives nothing, and neither end says
    // which one is broken. Show the actual response.
    if (n.lastWebhookFailure) {
        return el("div", { class: "warn-box" },
            el("strong", { text: "Webhook delivery is failing. " }),
            `Last attempt ${timeAgo(n.lastWebhookFailure.at)} — ${n.lastWebhookFailure.message}. `,
            "Messages are reaching this number but not your bot. ",
            el("em", { text: "If the endpoint uses the Authorization header for its own auth, " +
                "note the gateway sends its token as X-Wa-Gateway-Token instead." })
        );
    }
    // Paired and receiving, with nowhere to send it. Worth saying out loud: the
    // number looks perfectly healthy while every incoming message is dropped.
    if (n.status === "connected" && !n.webhookUrl) {
        return el("div", { class: "warn-box" },
            el("strong", { text: "No webhook set. " }),
            "This number is linked and can send, but incoming messages are discarded. " +
            "Add a webhook URL with “Edit” when the bot is ready for them."
        );
    }
    return null;
}

function editForm(n) {
    const form = el("form", {
        onsubmit: async (e) => {
            e.preventDefault();
            const data = new FormData(form);
            const patch = {
                webhookUrl: data.get("webhookUrl"),
                sendRatePerMinute: data.get("sendRatePerMinute"),
                rejectCalls: data.has("rejectCalls"),
                typingEvents: data.has("typingEvents"),
                mcp: data.has("mcp"),
            };
            // Only sent when the field was actually rendered. It is hidden for a
            // linked number, and an absent field reads as an empty string —
            // which the API would faithfully store as "cleared".
            if (data.has("pairPhone")) patch.pairPhone = data.get("pairPhone");
            try {
                const { number } = await api(`/numbers/${encodeURIComponent(n.id)}`, {
                    method: "PATCH",
                    body: JSON.stringify(patch),
                });
                editingId = null;
                await refresh();
                // Just switched on: the token is needed right now to set up the client.
                if (patch.mcp && !n.mcpEnabled && number?.mcpToken) showMcp(n.id, number.mcpToken);
                else startPolling();
            } catch (err) {
                if (err !== LOCKED) alert(err.message);
            }
        },
    },
        el("label", {},
            el("span", { text: "Webhook URL" }),
            el("input", {
                name: "webhookUrl",
                type: "url",
                value: n.webhookUrl || "",
                placeholder: "none — messages are discarded",
            })
        ),
        // Hidden once the number is linked, because it does nothing then: it is
        // only read while requesting a pairing code, and showing an editable
        // "phone" on a live session implies you could move it to another
        // account. You can't — the account is whichever phone scanned the code.
        n.status === "connected"
            ? null
            : el("label", {},
                el("span", { text: "Pair with a code instead of a QR" }),
                el("input", {
                    name: "pairPhone",
                    inputmode: "numeric",
                    value: n.pairPhone || "",
                    placeholder: "12025550100",
                }),
                el("small", {
                    text:
                        "The number you are linking, digits with country code. Used only to " +
                        "request an 8-character pairing code — it cannot change which WhatsApp " +
                        "account this session controls. Leave empty to scan a QR instead.",
                })
              ),
        el("label", {},
            el("span", { text: "Send rate / minute" }),
            el("input", {
                name: "sendRatePerMinute",
                type: "number",
                min: "1",
                max: "600",
                value: n.sendRatePerMinute ? String(n.sendRatePerMinute) : "",
                placeholder: "no limit",
            })
        ),
        el("label", { class: "check" },
            el("input", { name: "rejectCalls", type: "checkbox", checked: !!n.rejectCalls }),
            el("span", { text: "Reject calls" }),
            el("small", { text: "Audio and video calls are declined at once and the bot gets a calls event, so it can answer in text." })
        ),
        el("label", { class: "check" },
            el("input", { name: "typingEvents", type: "checkbox", checked: !!n.typingEvents }),
            el("span", { text: "Typing events" }),
            el("small", { text: "In 1:1 chats, the bot gets a presence event when someone is typing or recording, so it can wait for them." })
        ),
        el("label", { class: "check" },
            el("input", { name: "mcp", type: "checkbox", checked: !!n.mcpEnabled }),
            el("span", { text: "MCP access" }),
            el("small", { text: "Lets an assistant read chats and send as this account at /api/mcp, with its own token. Turning it off revokes the token and forgets the chat list and names." })
        ),
        el("div", { class: "row" },
            el("button", { type: "submit", text: "Save" }),
            el("button", {
                type: "button",
                class: "ghost",
                text: "Cancel",
                onclick: () => { editingId = null; refresh(); startPolling(); },
            })
        )
    );
    return form;
}

function actions(n) {
    const act = async (button, fn, confirmText) => {
        if (confirmText && !confirm(confirmText)) return;
        button.disabled = true;
        try {
            await fn();
            await refresh();
        } catch (err) {
            if (err !== LOCKED) alert(err.message);
        } finally {
            button.disabled = false;
        }
    };

    const edit = el("button", {
        class: "ghost",
        text: "Edit",
        onclick: () => { editingId = n.id; stopPolling(); refresh(); },
    });

    const token = el("button", {
        class: "ghost",
        text: "Show token",
        onclick: () => showToken(n.id, n.token),
    });

    const rotate = el("button", {
        class: "ghost",
        text: "Rotate token",
        onclick: (e) => act(
            e.currentTarget,
            async () => {
                const { token: fresh } = await api(`/numbers/${encodeURIComponent(n.id)}/rotate-token`, {
                    method: "POST",
                });
                showToken(n.id, fresh);
            },
            `Rotate ${n.id}'s token?\n\nThe old token stops working immediately — that bot goes silent until its token is updated.`
        ),
    });

    const restart = el("button", {
        class: "ghost",
        text: "Restart",
        onclick: (e) => act(
            e.currentTarget,
            () => api(`/numbers/${encodeURIComponent(n.id)}/restart`, { method: "POST" })
        ),
    });

    const relink = el("button", {
        class: "ghost",
        text: "Unlink & re-pair",
        onclick: (e) => act(
            e.currentTarget,
            () => api(`/numbers/${encodeURIComponent(n.id)}/relink`, { method: "POST" }),
            `Unlink ${n.id} from WhatsApp?\n\nIts credentials are wiped and you'll need to scan a new QR to bring the number back.`
        ),
    });

    const remove = el("button", {
        class: "danger",
        text: "Delete",
        onclick: (e) => act(
            e.currentTarget,
            () => api(`/numbers/${encodeURIComponent(n.id)}`, { method: "DELETE" }),
            `Delete ${n.id} completely?\n\nThe number is unlinked and everything stored for it — credentials, message keys, polls — is purged. This cannot be undone.`
        ),
    });

    const mcp = n.mcpEnabled
        ? el("button", {
            class: "ghost",
            text: "MCP setup",
            onclick: () => showMcp(n.id, n.mcpToken),
        })
        : null;

    const rotateMcp = n.mcpEnabled
        ? el("button", {
            class: "ghost",
            text: "Rotate MCP token",
            onclick: (e) => act(
                e.currentTarget,
                async () => {
                    const { mcpToken } = await api(`/numbers/${encodeURIComponent(n.id)}/rotate-mcp-token`, {
                        method: "POST",
                    });
                    showMcp(n.id, mcpToken);
                },
                `Rotate ${n.id}'s MCP token?\n\nThe old token stops working immediately — the assistant using it loses access until it is updated.`
            ),
        })
        : null;

    return el("div", { class: "row" }, edit, token, rotate, mcp, rotateMcp, restart, relink, remove);
}

function card(n) {
    const head = el("div", { class: "card-head" },
        el("h3", { text: n.id }),
        el("span", { class: `badge ${n.status}`, text: n.status })
    );

    if (editingId === n.id) {
        return el("div", { class: "card" }, head, editForm(n));
    }

    return el("div", { class: "card" },
        head,
        statusNote(n),
        pairingBlock(n),
        kv("Account", n.me?.id ? `${n.me.id}${n.me.name ? ` (${n.me.name})` : ""}` : "—"),
        // The line that answers "is this actually working?". A connected badge
        // only means a socket is open; this means messages are arriving.
        kv(
            "Last message",
            n.lastMessage
                ? el("span", { class: "v" },
                    el("strong", { text: timeAgo(n.lastMessage.at) }),
                    ` ${describeSender(n.lastMessage)}`
                  )
                : "none yet"
        ),
        kv("Phone number ID", n.phoneNumberId),
        kv("Webhook", n.webhookUrl || "not set"),
        kv("Connected since", n.connectedAt ? new Date(n.connectedAt).toLocaleString() : "—"),
        kv("Send rate", n.sendRatePerMinute ? `${n.sendRatePerMinute}/min` : "no limit"),
        kv("Calls", n.rejectCalls ? "rejected" : "ring as usual"),
        kv("Typing events", n.typingEvents ? "sent" : "off"),
        kv("MCP access", n.mcpEnabled ? "on" : "off"),
        n.webhookBacklog ? kv("Webhook backlog", String(n.webhookBacklog)) : null,
        n.reconnectAttempts ? kv("Reconnect attempts", String(n.reconnectAttempts)) : null,
        n.lastError ? kv("Last error", n.lastError) : null,
        actions(n)
    );
}

/**
 * Cards are cached against a signature of the data that produced them, and the
 * DOM is only touched when a signature actually changes.
 *
 * Rebuilding the list on every poll looks fine until you use it: at the three-
 * second pairing cadence it resets the scroll position, drops text selection
 * mid-copy, and re-decodes an unchanged QR image every tick. Since almost every
 * poll returns identical data, the common case here is now no DOM work at all.
 */
const cardCache = new Map();
let listEl = null;

function render(payload) {
    $("#api-base").textContent = payload.apiBaseUrl;
    mcpUrl = payload.mcpUrl || "";
    $("#mcp-url").textContent = mcpUrl;

    const numbers = payload.numbers || [];
    const connected = numbers.filter((n) => n.status === "connected").length;
    $("#summary").textContent = numbers.length
        ? `${connected} of ${numbers.length} connected`
        : "no numbers yet";

    if (!numbers.length) {
        cardCache.clear();
        listEl = null;
        $("#numbers").replaceChildren(
            el("section", { class: "empty" },
                "No numbers configured yet. Add one below — a pairing QR appears here as soon as it's created."
            )
        );
        return;
    }

    if (!listEl) {
        listEl = el("div", {});
        $("#numbers").replaceChildren(listEl);
    }

    const nodes = numbers.map((n) => {
        // The rendered "3 minutes ago" is part of the signature, not just the
        // timestamp behind it: the data doesn't change between messages, so a
        // signature over data alone would freeze the text at whatever it said
        // when the message landed.
        const sig =
            JSON.stringify(n) +
            "|" + timeAgo(n.lastMessage?.at) +
            "|" + timeAgo(n.lastWebhookFailure?.at) +
            (editingId === n.id ? "|editing" : "");
        const cached = cardCache.get(n.id);
        if (cached?.sig === sig) return cached.node;
        const node = card(n);
        cardCache.set(n.id, { sig, node });
        return node;
    });

    for (const id of [...cardCache.keys()]) {
        if (!numbers.some((n) => n.id === id)) cardCache.delete(id);
    }

    const current = [...listEl.children];
    if (current.length !== nodes.length || current.some((c, i) => c !== nodes[i])) {
        listEl.replaceChildren(...nodes);
    }
}

// --- token dialog ----------------------------------------------------------

/** From the list payload, so the command shows the real public URL and /api prefix. */
let mcpUrl = "";

function showMcp(id, token) {
    $("#mcp-for").textContent = id;
    $("#mcp-token").textContent = token;
    // Single-quoted for the shell; tokens are base64url, so nothing in them needs escaping.
    $("#mcp-command").textContent =
        `claude mcp add --transport http whatsapp-${id} ${mcpUrl} --header 'Authorization: Bearer ${token}'`;
    stopPolling();
    $("#mcp-dialog").showModal();
}

function showToken(id, token) {
    $("#token-for").textContent = id;
    $("#token-value").textContent = token;
    stopPolling();
    $("#token-dialog").showModal();
}

// --- data ------------------------------------------------------------------

let inFlight = false;

async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
        render(await api("/numbers"));
    } catch (err) {
        if (err !== LOCKED) console.error(err);
    } finally {
        inFlight = false;
    }
}

/**
 * A self-scheduling loop rather than a fixed interval, so the cadence can follow
 * what's on screen: fast enough that a rotating pairing QR stays scannable, slow
 * the rest of the time — this polls a Raspberry Pi that is also hosting the
 * WhatsApp sessions.
 *
 * It also re-decides after every render, which a `setInterval` set once at
 * unlock could not: a QR that appears two minutes later still gets the fast
 * cadence.
 */
function startPolling() {
    stopPolling();
    if (!key || $("#console").hidden || editingId || $("#token-dialog").open || $("#mcp-dialog").open || document.hidden) {
        return;
    }
    const pairing = document.querySelector(".pairing") !== null;
    pollTimer = setTimeout(async () => {
        await refresh();
        startPolling();
    }, pairing ? 3000 : 10000);
}

function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
}

// --- wiring ----------------------------------------------------------------

$("#unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    key = $("#key").value.trim();
    try {
        const payload = await api("/numbers");
        localStorage.setItem(KEY_STORAGE, key);
        unlocked();
        render(payload);
        startPolling();
    } catch (err) {
        // A rejected key already called lock(), which cleared the field.
        const msg = err === LOCKED ? "That key was rejected." : err.message;
        $("#unlock-error").textContent = msg;
        $("#unlock-error").hidden = false;
    }
});

$("#lock").addEventListener("click", lock);

$("#add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    $("#add-error").hidden = true;
    try {
        const { number } = await api("/numbers", {
            method: "POST",
            body: JSON.stringify({
                id: data.get("id"),
                webhookUrl: data.get("webhookUrl"),
                pairPhone: data.get("pairPhone"),
                sendRatePerMinute: data.get("sendRatePerMinute") || undefined,
                rejectCalls: data.has("rejectCalls"),
                typingEvents: data.has("typingEvents"),
                mcp: data.has("mcp"),
            }),
        });
        form.reset();
        await refresh();
        // The token is the one thing that can't be recovered from the list at a
        // glance, and it's needed immediately to configure the bot.
        showToken(number.id, number.token);
        if (number.mcpToken) $("#token-dialog").addEventListener("close", () => showMcp(number.id, number.mcpToken), { once: true });
    } catch (err) {
        if (err !== LOCKED) {
            $("#add-error").textContent = err.message;
            $("#add-error").hidden = false;
        }
    }
});

$("#token-close").addEventListener("click", () => $("#token-dialog").close());
$("#mcp-close").addEventListener("click", () => $("#mcp-dialog").close());
$("#mcp-dialog").addEventListener("close", () => { refresh(); startPolling(); });
$("#token-dialog").addEventListener("close", () => { refresh(); startPolling(); });

document.addEventListener("click", async (e) => {
    const button = e.target.closest(".copy");
    if (!button) return;
    const text = $(button.dataset.copy).textContent;
    try {
        await navigator.clipboard.writeText(text);
        const original = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => (button.textContent = original), 1200);
    } catch {
        // Clipboard access can be refused; selecting the text is the fallback.
        const range = document.createRange();
        range.selectNodeContents($(button.dataset.copy));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    }
});

// Don't keep polling a page nobody is looking at — the Pi has better things to do.
document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else if (key && !$("#console").hidden && !editingId) { refresh(); startPolling(); }
});

// --- boot ------------------------------------------------------------------

if (key) {
    unlocked();
    refresh().then(startPolling);
} else {
    lock();
}
