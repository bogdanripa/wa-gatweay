import {
    BufferJSON,
    initAuthCreds,
    proto,
    type AuthenticationCreds,
    type AuthenticationState,
    type SignalDataTypeMap,
} from "baileys";
import { scopedId, type Stores } from "./store.js";
import { logger } from "./log.js";

/**
 * Mongo-backed auth state, namespaced per session.
 *
 * This is the single most important piece of the migration. Baileys' bundled
 * `useMultiFileAuthState` writes to the container filesystem, which Pironman
 * replaces on every redeploy — you would be re-scanning a QR code after each
 * `apps_deploy`. The Baileys docs also say outright not to use it in production.
 *
 * Layout mirrors `useMultiFileAuthState` exactly (same BufferJSON encoding, same
 * app-state-sync-key special case), just with documents instead of files, and
 * every key prefixed with the session id:
 *   auth_creds: { _id: "<session>:creds",             value: "<json>" }
 *   auth_keys:  { _id: "<session>:<category>-<id>",   value: "<json>" }
 *
 * `SignalDataTypeMap` includes `lid-mapping`, so each number's LID<->phone table
 * persists here too. That matters: the bots derive country, language and timezone
 * from participant phone prefixes, so losing the mapping would silently degrade
 * behaviour rather than throw.
 */
export async function useMongoAuthState(
    stores: Stores,
    sessionId: string
): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clear: () => Promise<void>;
}> {
    const { authCreds, authKeys } = stores;
    const log = logger.child({ session: sessionId });

    // Ids can contain "/" and ":" — normalise the same way the file-based store
    // does, then scope to this session.
    const docId = (s: string) => scopedId(sessionId, s.replace(/\//g, "__").replace(/:/g, "-"));
    const credsId = scopedId(sessionId, "creds");

    const readKey = async (id: string): Promise<any | null> => {
        const doc = await authKeys.findOne({ _id: docId(id) });
        if (!doc) return null;
        try {
            return JSON.parse(doc.value, BufferJSON.reviver);
        } catch (e) {
            log.error({ e, id }, "failed to parse auth key; treating as absent");
            return null;
        }
    };

    const existing = await authCreds.findOne({ _id: credsId });
    const creds: AuthenticationCreds = existing
        ? JSON.parse(existing.value, BufferJSON.reviver)
        : initAuthCreds();

    const persist = async () => {
        await authCreds.updateOne(
            { _id: credsId },
            { $set: { value: JSON.stringify(creds, BufferJSON.replacer) } },
            { upsert: true }
        );
    };

    if (!existing) {
        log.warn("no stored credentials — this session needs pairing");
        // Write the freshly generated creds straight away, for two reasons.
        //
        // First, fail fast: if Mongo is read-only or the user lacks write
        // permission, we find out at boot instead of after you've scanned a QR
        // and watched the session evaporate on the next restart.
        //
        // Second, Baileys only emits `creds.update` when something materially
        // changes. During the pre-pairing QR loop that may not fire at all, so a
        // container restart mid-pairing would otherwise discard the noise key and
        // registration id it just generated.
        await persist();
        log.info("initialised and persisted fresh credentials");
    }

    return {
        state: {
            creds,
            keys: {
                get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
                    const data: { [id: string]: SignalDataTypeMap[T] } = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readKey(`${type}-${id}`);
                            if (type === "app-state-sync-key" && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            if (value) data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const ops: any[] = [];
                    for (const category in data) {
                        const entries = (data as any)[category];
                        for (const id in entries) {
                            const value = entries[id];
                            const _id = docId(`${category}-${id}`);
                            if (value) {
                                ops.push({
                                    updateOne: {
                                        filter: { _id },
                                        update: {
                                            $set: { value: JSON.stringify(value, BufferJSON.replacer) },
                                        },
                                        upsert: true,
                                    },
                                });
                            } else {
                                ops.push({ deleteOne: { filter: { _id } } });
                            }
                        }
                    }
                    if (ops.length) {
                        // Unordered: one failed delete shouldn't abandon the rest of the batch.
                        await authKeys.bulkWrite(ops, { ordered: false });
                    }
                },
            },
        },

        saveCreds: persist,

        /**
         * Wipe just this session. Used after a `loggedOut` disconnect — the prefix
         * match is what keeps it from touching the other numbers' credentials.
         */
        clear: async () => {
            const prefix = new RegExp(`^${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
            await Promise.all([
                authCreds.deleteMany({ _id: credsId }),
                authKeys.deleteMany({ _id: { $regex: prefix } }),
            ]);
            log.warn("auth state cleared — re-pairing required");
        },
    };
}
