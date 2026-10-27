/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

// Discord's renderer CSP blocks connect-src to *.discordsays.com, so the activity backend
// has to be reached from here, in the main process, where the CSP does not apply.
//
// These handlers run in the privileged, CSP free main process on behalf of the renderer, so
// every renderer supplied value that shapes the request is validated here, not just appId.
const NUMERIC_ID = /^\d+$/;

export interface DiscordSaysResponse {
    ok: boolean;
    status: number;
    /** raw response body, the handlers never interpret it */
    body: string;
}

function validParams(appId: string, questId: string, referrer: string): boolean {
    if (!NUMERIC_ID.test(String(appId)) || !NUMERIC_ID.test(String(questId))) return false;

    try {
        const url = new URL(referrer);
        return url.protocol === "https:" && url.hostname === `${appId}.discordsays.com`;
    } catch {
        return false;
    }
}

function rejected(): DiscordSaysResponse {
    return { ok: false, status: 0, body: JSON.stringify({ error: "invalid request params" }) };
}

async function discordsaysPost(url: string, headers: Record<string, string>, body: string): Promise<DiscordSaysResponse> {
    try {
        // redirect:"error" so a 3xx cannot bounce the proxy ticket Referer or the auth token
        // to another host from the CSP free main process. The acf endpoints answer directly.
        const response = await fetch(url, { method: "POST", headers, body, redirect: "error" });
        return { ok: response.ok, status: response.status, body: await response.text() };
    } catch (error) {
        return { ok: false, status: 0, body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) };
    }
}

export async function discordsaysAuthorize(_: IpcMainInvokeEvent, opts: { appId: string; questId: string; authCode: string; referrer: string; }): Promise<DiscordSaysResponse> {
    if (!validParams(opts.appId, opts.questId, opts.referrer)) return rejected();
    if (typeof opts.authCode !== "string" || !opts.authCode) return rejected();

    return discordsaysPost(
        `https://${opts.appId}.discordsays.com/.proxy/acf/authorize`,
        {
            "Content-Type": "application/json",
            "X-Auth-Token": "",
            "X-Discord-Quest-ID": opts.questId,
            Referer: opts.referrer
        },
        JSON.stringify({ code: opts.authCode })
    );
}

export async function discordsaysProgress(_: IpcMainInvokeEvent, opts: { appId: string; questId: string; token: string; target: number; referrer: string; }): Promise<DiscordSaysResponse> {
    if (!validParams(opts.appId, opts.questId, opts.referrer)) return rejected();
    if (typeof opts.token !== "string" || !opts.token) return rejected();
    if (!Number.isFinite(opts.target)) return rejected();

    return discordsaysPost(
        `https://${opts.appId}.discordsays.com/.proxy/acf/quest/progress`,
        {
            "Content-Type": "application/json",
            "X-Auth-Token": opts.token,
            "X-Discord-Quest-ID": opts.questId,
            Referer: opts.referrer
        },
        JSON.stringify({ progress: opts.target })
    );
}
