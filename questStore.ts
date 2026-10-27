/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazyWebpack, wreq } from "@webpack";

import type { Quest } from "./types";

export interface QuestsStore {
    quests: Map<string, Quest> | Record<string, Quest>;
    getQuest(id: string): Quest | undefined;
}

/**
 * Discord minifies the module export names, so we can't just look up a store by property path.
 * Instead we look for a module that exposes the given key, preferring ones that also expose
 * `preferredKey` (which lets us pick the quest store over any other module that happens to
 * expose `getQuest`).
 */
function findExportsExposing(property: string, preferredProperty?: string): any {
    let fallback: any = null;

    for (const module of Object.values(wreq.c)) {
        const exports = module?.exports;
        if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;

        for (const value of [exports, ...Object.values(exports)]) {
            if (!value || (typeof value !== "object" && typeof value !== "function")) continue;

            try {
                if (!(property in value)) continue;
                if (!preferredProperty || preferredProperty in value) return value;
                fallback ??= value;
            } catch {
                // getters on the module namespace may throw, just ignore those
            }
        }
    }

    return fallback;
}

export const QuestsStore = proxyLazyWebpack(
    () => findExportsExposing("getQuest", "quests") as QuestsStore | null
);
