/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { findByCodeLazy, findStoreLazy } from "@webpack";
import {
    ApplicationStreamingStore,
    FluxDispatcher,
    GuildChannelStore,
    GuildStore,
    RestAPI,
    RunningGameStore,
    SelectedGuildStore,
    showToast,
    Toasts,
    UserStore,
    WindowStore,
} from "@webpack/common";

import { getAllQuests, getApplicationId, getExpiresAt, getOrbReward, getQuestName, getReportedProgress, getTarget, getTaskName, isClaimable, isCompleted, isEnrolled, isExpired, isTaskRunnable } from "./quests";
import { settings } from "./settings";
import type { Quest, SupportedTask } from "./types";

const Native = VencordNative.pluginHelpers.QuestAutoComplete as PluginNative<typeof import("./native")>;

/** How often we re-read the quest store so the UI stays live */
const POLL_INTERVAL = 5_000;
/** Interval between PLAY_ACTIVITY heartbeats, matches Discord's own cadence */
const ACTIVITY_HEARTBEAT_INTERVAL = 20_000;
/** How far the shown bar may lead the last heartbeat while waiting for the next one */
const DISPLAY_LEAD_SECONDS = 30;
/** QUEST_HOME_DESKTOP, the quest content location Discord's own client enrolls from */
const QUEST_CONTENT_LOCATION = 11;

/**
 * Discord's own "accept quest" flow. Firing the same action the client uses keeps the
 * request shape correct (the raw REST body is easy to get wrong), and the store updates
 * from the resulting gateway event just like a normal click would.
 */
const QuestApplyAction = findByCodeLazy("type:\"QUESTS_ENROLL_BEGIN\"") as (
    questId: string,
    action: { questContent: number; questContentCTA: string; sourceQuestContent: number; }
) => Promise<unknown>;

/**
 * Discord's own "claim reward" flow. Going through the client's action means a required
 * captcha surfaces through Discord's normal prompt instead of failing silently, which is
 * exactly what we want: the user solves it, we never touch it.
 */
const QuestClaimAction = findByCodeLazy("type:\"QUESTS_CLAIM_REWARD_BEGIN\"") as (
    questId: string,
    platform?: number,
    location?: number,
    metadata?: any
) => Promise<unknown>;

/** Used for a PLAY_ACTIVITY stream key when the user has no server voice channel open */
const ChannelStore = findStoreLazy("ChannelStore") as {
    getSortedPrivateChannels(): Array<{ id: string; }>;
};

class CancelledError extends Error {
    constructor() {
        super("cancelled");
        this.name = "CancelledError";
    }
}

function isCancelled(error: unknown) {
    return error instanceof CancelledError;
}

/** Not abortable on purpose: a claim that already reached Discord has to finish. */
function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new CancelledError());
            return;
        }

        const onAbort = () => {
            clearTimeout(timeout);
            reject(new CancelledError());
        };
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export type RunStatus = "idle" | "running" | "done" | "error";

export interface QuestRun {
    id: string;
    name: string;
    taskName: SupportedTask;
    /** Amount of seconds needed for the quest to complete */
    target: number;
    /** Progress Discord told us about */
    reported: number;
    /** When `reported` last changed, used to keep the shown bar moving between heartbeats */
    reportedAt: number;
    /** Progress we reported ourselves (only relevant for video quests) */
    spoofed: number;
    status: RunStatus;
    /** Set while a global-store quest is waiting for another one to finish spoofing */
    queued: boolean;
    error?: string;
    startedAt: number | null;
}

const runs = new Map<string, QuestRun>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
/**
 * Quests this plugin completed itself while running, used only to make sure the
 * completion toast fires once per quest.
 *
 * The claim banner deliberately does not use this. It reads the claimable state
 * straight off the quest store instead, so it survives a reload without needing to
 * persist anything.
 */
const trackedCompletions = new Set<string>();

let version = 0;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let claimableCache: Quest[] | null = null;

function emit() {
    version++;
    claimableCache = null;
    for (const listener of [...listeners]) listener();
}

export const engine = {
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
    },
    getVersion() {
        return version;
    }
};

export function getRunProgress(run: QuestRun) {
    return Math.max(run.reported, run.spoofed);
}

export function getRun(questId: string): QuestRun | undefined {
    return runs.get(questId);
}

export function getRuns(): QuestRun[] {
    return [...runs.values()];
}

export function getRunningRuns(): QuestRun[] {
    return getRuns().filter(run => run.status === "running");
}

/** Average completion percentage (0-100) across all currently running quests */
export function getRunningProgress(): number {
    const running = getRunningRuns();
    if (running.length === 0) return 0;

    let total = 0;
    for (const run of running) {
        total += run.target > 0 ? Math.min(1, getRunProgress(run) / run.target) : 0;
    }
    return total / running.length * 100;
}

export function isQuestRunning(questId: string) {
    return controllers.has(questId);
}

/**
 * Every quest Discord reports as finished with an unclaimed reward, whether we
 * completed it this session, a previous one, or the user did it by hand.
 *
 * Expired quests are skipped: they can no longer be claimed, and without this an
 * old quest we misread as unclaimed would pin the rail badge on forever.
 */
export function getClaimableQuests(): Quest[] {
    if (claimableCache) return claimableCache;

    const claimable: Quest[] = [];
    for (const quest of getAllQuests()) {
        if (isExpired(quest)) continue;
        if (isClaimable(quest)) claimable.push(quest);
    }

    // soonest to expire first, same order the rest of the modal uses
    claimable.sort((a, b) => (getExpiresAt(a) || Infinity) - (getExpiresAt(b) || Infinity));

    return (claimableCache = claimable);
}

export interface OverallProgress {
    /** Seconds of progress across every joined, incomplete quest */
    value: number;
    /** Seconds needed to finish all of them */
    total: number;
    /** value / total, 0-100 */
    percent: number;
    count: number;
}

/** Aggregate progress across every joined quest that can still be automated */
export function getOverallProgress(): OverallProgress {
    let value = 0;
    let total = 0;
    let count = 0;

    for (const quest of getAllQuests()) {
        if (!isEnrolled(quest) || isCompleted(quest) || isExpired(quest)) continue;

        const taskName = getTaskName(quest);
        if (!taskName) continue;

        const target = getTarget(quest, taskName);
        if (target <= 0) continue;

        // a task the plugin currently refuses to run must not count towards the bar
        if (!isTaskRunnable(taskName)) continue;

        const run = runs.get(quest.id);
        const reported = run ? getRunProgress(run) : getReportedProgress(quest, taskName);

        count++;
        total += target;
        value += Math.min(target, Math.max(0, reported));
    }

    return { value, total, percent: total > 0 ? value / total * 100 : 0, count };
}

export function getClaimableCount(): number {
    return getClaimableQuests().length;
}

function getHeartbeatProgress(data: any, quest: Quest, taskName: SupportedTask) {
    const status = data?.userStatus;
    if (!status) return 0;
    if (quest.config?.configVersion === 1) return status.streamProgressSeconds ?? 0;

    const { progress } = status;
    const entry = progress instanceof Map ? progress.get(taskName) : progress?.[taskName];
    return entry?.value ?? 0;
}

function findVoiceChannelId(): string | undefined {
    // A DM channel is enough for the heartbeat's stream key and works with no servers
    try {
        const dmChannelId = ChannelStore?.getSortedPrivateChannels?.()?.[0]?.id;
        if (dmChannelId) return dmChannelId;
    } catch {
        // the channel store can be missing, fall through to the guild channels
    }

    const currentGuildId = SelectedGuildStore?.getGuildId();
    if (currentGuildId) {
        const channels = GuildChannelStore.getChannels(currentGuildId)?.VOCAL;
        if (channels?.length) return channels[0].channel.id;
    }

    for (const guildId of GuildStore.getGuildIds()) {
        const channels = GuildChannelStore.getChannels(guildId)?.VOCAL;
        if (channels?.length) return channels[0].channel.id;
    }

    return undefined;
}

async function runVideoQuest(run: QuestRun, quest: Quest, signal: AbortSignal) {
    const step = Math.min(Math.max(settings.store.videoProgressStep, 1), 60);

    while (true) {
        if (signal.aborted) throw new CancelledError();

        const current = getRunProgress(run);
        if (current >= run.target) break;

        const end = Math.min(run.target, current + step);

        // Keep the shown bar moving once a second while we wait for the next report,
        // otherwise it only jumps every `step` seconds and looks frozen.
        let elapsed = 0;
        const span = end - current;
        while (elapsed < span) {
            await delay(Math.min(1, span - elapsed) * 1_000, signal);
            elapsed = Math.min(span, elapsed + 1);
            run.spoofed = Math.max(run.spoofed, current + elapsed);
            emit();
        }

        const response = await RestAPI.post({
            url: `/quests/${quest.id}/video-progress`,
            body: { timestamp: Math.min(run.target, end + Math.random()) }
        });

        const body = response?.body;
        const completed = body?.completed_at != null;
        if (completed) {
            run.reported = run.target;
        } else {
            const value = body?.progress?.[run.taskName]?.value;
            if (typeof value === "number" && value > run.reported) run.reported = value;
        }

        emit();
        if (completed) break;
    }
}

function requireDesktopApp() {
    if (!IS_DISCORD_DESKTOP && !IS_VESKTOP) {
        throw new Error("This quest only works in the Discord desktop app");
    }
}

function fakePid() {
    return Math.floor(Math.random() * 30_000) + 1_000;
}

/**
 * Spoofs a store getter, waits until the quest heartbeat reports full progress,
 * then restores everything it touched.
 */
function waitForHeartbeatProgress(
    quest: Quest,
    run: QuestRun,
    signal: AbortSignal,
    setup: () => () => void
) {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let restore = () => { };

        const cleanup = () => {
            signal.removeEventListener("abort", onAbort);
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
            restore();
        };

        function finish() {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        }

        function onHeartbeat(data: any) {
            const value = getHeartbeatProgress(data, quest, run.taskName);
            if (value > run.reported) {
                run.reported = value;
                run.reportedAt = Date.now();
            }
            emit();

            if (value >= run.target) finish();
        }

        function onAbort() {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new CancelledError());
        }

        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
        signal.addEventListener("abort", onAbort, { once: true });

        try {
            restore = setup();
        } catch (error) {
            settled = true;
            cleanup();
            reject(error);
        }
    });
}

async function runDesktopGameQuest(run: QuestRun, quest: Quest, signal: AbortSignal) {
    requireDesktopApp();

    const applicationId = getApplicationId(quest, run.taskName);
    if (!applicationId) throw new Error("This quest has no associated application");

    const response = await RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` });
    const appData = response?.body?.[0];
    if (!appData?.name) throw new Error("Could not look up the quest application");

    const exeName = appData.executables?.find((x: any) => x.os === "win32")?.name?.replace(">", "")
        ?? String(appData.name).replace(/[/\\:*?"<>|]/g, "");

    const pid = fakePid();
    const fakeGame = {
        cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
        exeName,
        exePath: `c:/program files/${String(appData.name).toLowerCase()}/${exeName}`,
        hidden: false,
        isLauncher: false,
        id: applicationId,
        name: appData.name,
        pid,
        pidPath: [pid],
        processName: appData.name,
        start: Date.now(),
    };

    await waitForHeartbeatProgress(quest, run, signal, () => {
        const realGetRunningGames = RunningGameStore.getRunningGames;
        const realGetGameForPID = RunningGameStore.getGameForPID;
        const fakeGames: any[] = [fakeGame];
        const realGames = RunningGameStore.getRunningGames() ?? [];

        RunningGameStore.getRunningGames = () => fakeGames;
        RunningGameStore.getGameForPID = (gamePid: number) => fakeGames.find(game => game.pid === gamePid) as any;

        FluxDispatcher.dispatch({
            type: "RUNNING_GAMES_CHANGE",
            removed: realGames,
            added: [fakeGame],
            games: fakeGames
        });

        return () => {
            RunningGameStore.getRunningGames = realGetRunningGames;
            RunningGameStore.getGameForPID = realGetGameForPID;
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
        };
    });
}

async function runStreamingQuest(run: QuestRun, quest: Quest, signal: AbortSignal) {
    requireDesktopApp();

    const applicationId = getApplicationId(quest, run.taskName);
    if (!applicationId) throw new Error("This quest has no associated application");

    const pid = fakePid();

    await waitForHeartbeatProgress(quest, run, signal, () => {
        const realGetStreamerActiveStreamMetadata = ApplicationStreamingStore.getStreamerActiveStreamMetadata;

        ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
            id: applicationId,
            pid,
            sourceName: null
        });

        return () => {
            ApplicationStreamingStore.getStreamerActiveStreamMetadata = realGetStreamerActiveStreamMetadata;
        };
    });
}

async function runActivityQuest(run: QuestRun, quest: Quest, signal: AbortSignal) {
    const channelId = findVoiceChannelId();
        if (!channelId) throw new Error("You need to be in a voice channel, a DM call works too");

    const streamKey = `call:${channelId}:1`;

    while (true) {
        if (signal.aborted) throw new CancelledError();

        const response = await RestAPI.post({
            url: `/quests/${quest.id}/heartbeat`,
            body: { stream_key: streamKey, terminal: false }
        });

        const value = response?.body?.progress?.[run.taskName]?.value;
        if (typeof value === "number" && value > run.reported) {
            run.reported = value;
            run.reportedAt = Date.now();
        }
        emit();

        if (run.reported >= run.target) {
            await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } });
            break;
        }

        await delay(ACTIVITY_HEARTBEAT_INTERVAL, signal);
    }
}

/** Scopes the activity is authorized for, the same set the embedded app asks Discord for */
const ACHIEVEMENT_SCOPE = "identify applications.commands applications.entitlements";

/**
 * How long to wait for Discord to credit an ACHIEVEMENT_IN_ACTIVITY quest after the activity
 * backend accepted the report. The credit arrives on the gateway; waiting for it here means the
 * reward is offered the moment it exists instead of one poll later.
 */
const ACHIEVEMENT_CREDIT_TIMEOUT = 20_000;

/** Every OAuth grant id the account already has for this activity */
async function listActivityGrantIds(applicationId: string): Promise<Set<string>> {
    const response = await RestAPI.get({ url: "/oauth2/tokens" });
    const grants: any[] = Array.isArray(response?.body) ? response.body : [];

    const ids = new Set<string>();
    for (const grant of grants) {
        if (grant?.application?.id === applicationId && typeof grant.id === "string") ids.add(grant.id);
    }
    return ids;
}

/**
 * Revokes every grant for this activity that was not there before the run. Only grants this run
 * could have created are touched, so a pre-existing authorization the user set up themselves is
 * left alone. Failures are logged, never thrown: a cleanup problem must not turn a completed
 * quest into a failed one.
 */
async function revokeActivityGrants(applicationId: string, preGrantIds: Set<string>) {
    try {
        const response = await RestAPI.get({ url: "/oauth2/tokens" });
        const grants: any[] = Array.isArray(response?.body) ? response.body : [];

        for (const grant of grants) {
            if (grant?.application?.id !== applicationId) continue;
            if (typeof grant.id !== "string" || preGrantIds.has(grant.id)) continue;

            try {
                await RestAPI.del({ url: `/oauth2/tokens/${grant.id}` });
            } catch (error) {
                console.error("[questAutoComplete] could not revoke the activity connection", {
                    id: grant.id,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    } catch (error) {
        console.error("[questAutoComplete] could not clean up the activity connection", error);
    }
}

function readActivityToken(body: string): string | null {
    try {
        const parsed = JSON.parse(body);
        return typeof parsed?.token === "string" && parsed.token ? parsed.token : null;
    } catch {
        return null;
    }
}

function readActivityError(body: string): string {
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.message === "string" && parsed.message) return parsed.message;
        if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
        if (typeof parsed?.code === "number") return `code ${parsed.code}`;
    } catch {
        // not JSON, fall through
    }
    return "";
}

function activityError(message: string, response: { status: number; body: string; }) {
    const detail = readActivityError(response.body);
    return new Error(`${message} (HTTP ${response.status}${detail ? ` - ${detail}` : ""})`);
}

/**
 * Turns one of Discord's REST rejections into a message the user can act on. Those rejections are
 * plain `{ status, body }` objects rather than Errors, so their message is lost as "[object Object]"
 * unless it is read out by hand.
 */
function restErrorMessage(error: unknown): string {
    const err = error as any;
    const body = err?.body ?? err?.data;

    const code = typeof body?.code === "number" ? body.code : typeof err?.code === "number" ? err.code : null;
    if (code === 50165) return "Discord does not offer this activity on your account (age-gated or delisted)";

    const status = typeof err?.status === "number" ? err.status : null;
    const message = typeof body?.message === "string" ? body.message : error instanceof Error ? error.message : String(error);
    const suffix = [status != null ? `HTTP ${status}` : null, code != null ? `code ${code}` : null].filter(Boolean).join(", ");

    return suffix ? `${message} (${suffix})` : message;
}

/**
 * Best effort: the report already succeeded, so this never throws on timeout, it just warns.
 * The completion poll picks the quest up on its next tick either way.
 */
async function waitForAchievementCredit(questId: string, signal: AbortSignal) {
    const deadline = Date.now() + ACHIEVEMENT_CREDIT_TIMEOUT;

    while (Date.now() < deadline) {
        const quest = getAllQuests().find(candidate => candidate.id === questId);
        if (quest && isCompleted(quest)) return;

        await delay(1_000, signal);
    }

    try {
        const response = await RestAPI.get({ url: `/quests/${questId}` });
        if (response?.body?.user_status?.completed_at) return;
    } catch (error) {
        console.warn("[questAutoComplete] could not confirm the achievement quest was credited", error);
    }

    console.warn(`[questAutoComplete] Discord has not credited quest ${questId} yet, the next poll will pick it up`);
}

/**
 * ACHIEVEMENT_IN_ACTIVITY quests have no client heartbeat at all: Discord only accepts progress
 * from inside the activity, and heartbeating this type is answered with a 403. The activity
 * backend sits behind {appId}.discordsays.com, which the renderer CSP blocks, so the calls run in
 * the main process. This mirrors the handshake the embedded app performs itself: ask Discord for
 * an authorization code, trade it with the activity for a token scoped to the quest, then report
 * the progress.
 *
 * Authorizing creates a real OAuth grant, so it is snapshotted before and revoked after, whatever
 * the outcome. Triggered only by an explicit button press, never automatically.
 */
async function runAchievementQuest(run: QuestRun, quest: Quest, signal: AbortSignal) {
    requireDesktopApp();

    if (!settings.store.achievementBypass) throw new Error("Achievement bypass is turned off in the plugin settings");
    if (!Native) throw new Error("The desktop client is missing the activity helper, restart Discord");

    const applicationId = getApplicationId(quest, run.taskName);
    if (!applicationId) throw new Error("This quest has no associated application");
    if (!/^\d+$/.test(applicationId)) throw new Error("This quest has an unusable application id");

    const accountId = UserStore?.getCurrentUser?.()?.id ?? null;
    if (!accountId) throw new Error("Discord has not loaded your account yet, try again in a moment");

    // Snapshot first: cleanup may only ever remove a grant this run created
    let preGrantIds: Set<string>;
    try {
        preGrantIds = await listActivityGrantIds(applicationId);
    } catch {
        throw new Error("Could not read your existing connections, so nothing was authorized");
    }

    // set before the request: the grant exists the moment Discord answers, even if the body is unusable
    let authorized = false;
    try {
        if (signal.aborted) throw new CancelledError();

        authorized = true;
        const authorizeResponse = await RestAPI.post({
            url: "/oauth2/authorize",
            query: {
                response_type: "code",
                client_id: applicationId,
                scope: ACHIEVEMENT_SCOPE
            },
            body: {
                permissions: "0",
                authorize: true,
                integration_type: 1,
                location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
            }
        });

        if (signal.aborted) throw new CancelledError();

        const location = authorizeResponse?.body?.location;
        if (typeof location !== "string") throw new Error("Discord did not return an authorization location");

        const authCode = new URL(location).searchParams.get("code");
        if (!authCode) throw new Error("Discord did not return an authorization code");

        const ticketResponse = await RestAPI.post({ url: `/applications/${applicationId}/proxy-tickets`, body: {} });
        if (signal.aborted) throw new CancelledError();

        const ticket = ticketResponse?.body?.ticket;
        if (typeof ticket !== "string" || !ticket) throw new Error("Discord did not issue a proxy ticket");

        const referrer = `https://${applicationId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(ticket)}`;

        const auth = await Native.discordsaysAuthorize({ appId: applicationId, questId: quest.id, authCode, referrer });
        if (signal.aborted) throw new CancelledError();
        if (!auth.ok) throw activityError("The activity rejected the authorization", auth);

        const token = readActivityToken(auth.body);
        if (!token) throw new Error("The activity did not return a token");

        const progress = await Native.discordsaysProgress({ appId: applicationId, questId: quest.id, token, target: run.target, referrer });
        if (signal.aborted) throw new CancelledError();
        if (!progress.ok) throw activityError("The activity rejected the progress report", progress);
    } catch (error) {
        // Discord's REST rejections are plain objects, so their reason has to be read out by hand
        const err = error as any;
        if (error instanceof Error && !err?.body && !err?.data) throw error;
        throw new Error(restErrorMessage(error));
    } finally {
        // only revoke while the account is still the one that authorized, never touch a different one
        if (authorized && UserStore?.getCurrentUser?.()?.id === accountId) {
            await revokeActivityGrants(applicationId, preGrantIds);
        }
    }

    // the report is in, wait for Discord to confirm it before the reward is advertised as ready
    await waitForAchievementCredit(quest.id, signal);
}

/**
 * PLAY_ON_DESKTOP and STREAM_ON_DESKTOP both fake process-wide singletons, so two of
 * them running at once would overwrite each other's store and let a heartbeat match
 * the wrong quest. Serialize them: one spoofs at a time, the rest wait their turn.
 */
let globalSpoofDepth = 0;
let globalSpoofChain: Promise<unknown> = Promise.resolve();

async function runGlobalSpoof(run: QuestRun, signal: AbortSignal, task: () => Promise<void>) {
    if (globalSpoofDepth > 0) {
        run.queued = true;
        emit();
    }

    globalSpoofDepth++;

    try {
        const previous = globalSpoofChain;
        const started = previous.then(() => {
            if (signal.aborted) throw new CancelledError();
            run.queued = false;
            emit();
            return task();
        });

        globalSpoofChain = started.catch(() => { });
        await started;
    } finally {
        globalSpoofDepth--;
    }
}

async function runQuest(run: QuestRun, quest: Quest, signal: AbortSignal) {
    try {
        switch (run.taskName) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                await runVideoQuest(run, quest, signal);
                break;
            case "PLAY_ON_DESKTOP":
                await runGlobalSpoof(run, signal, () => runDesktopGameQuest(run, quest, signal));
                break;
            case "STREAM_ON_DESKTOP":
                await runGlobalSpoof(run, signal, () => runStreamingQuest(run, quest, signal));
                break;
            case "PLAY_ACTIVITY":
                await runActivityQuest(run, quest, signal);
                break;
            case "ACHIEVEMENT_IN_ACTIVITY":
                await runAchievementQuest(run, quest, signal);
                break;
        }

        run.status = "done";
        run.reported = run.target;
        notifyComplete(run.name, quest);
    } catch (error) {
        if (isCancelled(error)) {
            if (run.status !== "done") run.status = "idle";
        } else {
            run.status = "error";
            run.error = error instanceof Error ? error.message : String(error);
            showToast(`"${run.name}" could not be completed: ${run.error}`, Toasts.Type.FAILURE);
        }
    } finally {
        run.queued = false;
        controllers.delete(run.id);
        emit();
    }
}

function notifyComplete(name: string, quest: Quest) {
    if (trackedCompletions.has(quest.id)) return;
    trackedCompletions.add(quest.id);

    if (!settings.store.notifyOnComplete) return;

    // re-read so the reward hint reflects Discord's latest state, not a stale snapshot
    const current = getAllQuests().find(candidate => candidate.id === quest.id) ?? quest;
    const rewardHint = isClaimable(current) ? " - reward ready to claim" : "";
    const message = `Quest completed: ${name}${rewardHint}`;

    console.log(`[questAutoComplete] ${message}`);
    Toasts.show({
        id: Toasts.genId(),
        message,
        type: Toasts.Type.SUCCESS,
        options: {
            // Discord's own reward toast sits at the top, ours gets lost in it
            position: Toasts.Position.BOTTOM,
        },
    });
}

/** Starts a single quest. Does nothing if it is already running or cannot be handled. */
export function startQuest(quest: Quest): boolean {
    if (isCompleted(quest)) return false;

    const taskName = getTaskName(quest);
    const target = taskName ? getTarget(quest, taskName) : 0;
    if (!taskName || target <= 0) return false;
    if (!isTaskRunnable(taskName)) return false;
    if (controllers.has(quest.id)) return false;

    const run: QuestRun = {
        id: quest.id,
        name: getQuestName(quest),
        taskName,
        target,
        reported: getReportedProgress(quest, taskName),
        reportedAt: Date.now(),
        spoofed: 0,
        status: "running",
        queued: false,
        startedAt: Date.now()
    };

    runs.set(quest.id, run);
    const controller = new AbortController();
    controllers.set(quest.id, controller);
    emit();

    void runQuest(run, quest, controller.signal);
    return true;
}

export function startQuests(quests: Quest[]) {
    let started = 0;
    for (const quest of quests) {
        if (startQuest(quest)) started++;
    }
    return started;
}

export function stopQuest(questId: string) {
    const controller = controllers.get(questId);
    if (!controller) return false;
    controller.abort();
    return true;
}

export function stopAll() {
    for (const controller of [...controllers.values()]) controller.abort();
}

/**
 * Joins a quest the user has not accepted yet. This is only ever triggered by an
 * explicit button press, never automatically, because enrolling fires the same
 * kind of request Discord may answer with a captcha.
 */
export async function enrollQuest(questId: string): Promise<boolean> {
    try {
        await QuestApplyAction(questId, {
            questContent: QUEST_CONTENT_LOCATION,
            questContentCTA: "ACCEPT_QUEST",
            sourceQuestContent: 0
        });

        // the store is updated by the gateway event, give it a moment then re-read
        setTimeout(refresh, 1_000);
        refresh();
        return true;
    } catch (error) {
        showToast(`Could not join this quest: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE);
        return false;
    }
}

/** Everything Discord told us when a claim did not go through */
interface ClaimErrorInfo {
    status: number | null;
    code: number | null;
    message: string;
    /** milliseconds Discord asked us to wait, 0 when it did not ask */
    retryAfter: number;
    captcha: boolean;
}

/**
 * Discord's own RestAPI rejects with `{ status, body }` where body carries the API
 * error, and its actions reject with a plain Error holding the same status. Read every
 * shape so a 429 can be respected instead of being swallowed into a generic failure.
 */
function readClaimError(error: unknown): ClaimErrorInfo {
    const err = error as any;
    const body = err?.body ?? err?.data ?? err;

    const retryAfterSeconds = body?.retry_after ?? body?.retryAfter;
    const retryAfter = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1_000
        : 0;

    return {
        status: typeof err?.status === "number" ? err.status : typeof body?.status === "number" ? body.status : null,
        code: typeof body?.code === "number" ? body.code : null,
        message: typeof body?.message === "string" ? body.message : error instanceof Error ? error.message : String(error),
        retryAfter,
        captcha: Boolean(body?.captcha_key || body?.captcha_sitekey)
    };
}

type ClaimStatus = "claimed" | "captcha" | "rate-limited" | "failed";

interface ClaimResult {
    status: ClaimStatus;
    retryAfter: number;
    message: string;
}

function claimFailure(status: ClaimStatus, info: ClaimErrorInfo): ClaimResult {
    const detail = info.code != null ? `${info.message} (${info.code})` : info.message;
    console.error(`[questAutoComplete] claim ${status}`, { status: info.status, retryAfter: info.retryAfter, detail });
    return { status, retryAfter: info.retryAfter, message: detail };
}

async function claimOne(questId: string): Promise<ClaimResult> {
    try {
        await QuestClaimAction(questId, 0, QUEST_CONTENT_LOCATION);
        return { status: "claimed", retryAfter: 0, message: "" };
    } catch (error) {
        const info = readClaimError(error);
        if (info.captcha) return claimFailure("captcha", info);
        if (info.status === 429) return claimFailure("rate-limited", info);

        // Discord answered and refused the claim. Sending it again by hand would only
        // produce a second identical error in the network log while losing the reason.
        // Try REST fallback on any failure that is not captcha/429. The action sometimes
        // expects additional sealed metadata that varies by quest and can cause 400s;
        // the documented REST endpoint only needs location and platform.
        return claimViaRest(questId, info);
    }
}

async function claimViaRest(questId: string, original: ClaimErrorInfo): Promise<ClaimResult> {
    console.warn(`[questAutoComplete] claim action unavailable (${original.message}), using the endpoint directly`);

    try {
        await RestAPI.post({
            url: `/quests/${questId}/claim-reward`,
            body: { location: QUEST_CONTENT_LOCATION, platform: 0 }
        });
        return { status: "claimed", retryAfter: 0, message: "" };
    } catch (error) {
        const info = readClaimError(error);
        if (info.captcha) return claimFailure("captcha", info);
        if (info.status === 429) return claimFailure("rate-limited", info);
        return claimFailure("failed", info);
    }
}

export interface ClaimOutcome {
    claimed: number;
    captcha: number;
    failed: number;
    orbs: number;
    /** the last thing Discord said about a claim that did not go through */
    message: string;
}

/**
 * Set while a batch is being claimed. Guards against a second batch starting, which
 * matters because the modal's own state resets if it is closed and reopened mid-run.
 */
let claimInFlight = false;

/** Gap between claims so Discord's store can catch up with the gateway events. */
const CLAIM_GAP = 1_500;
/** Slack added on top of a retry_after before trying again */
const RATE_LIMIT_SLACK = 1_000;
/** Cap on how long we will sit on a rate limit before giving up on a quest */
const MAX_RATE_LIMIT_WAIT = 30_000;
/** How many times one quest may be retried after a rate limit */
const MAX_RATE_LIMIT_RETRIES = 3;

export function isClaiming() {
    return claimInFlight;
}

/**
 * Claims the rewards for the given quests strictly one at a time: the next claim only
 * starts after the previous one came back and the store was re-read, with a short gap in
 * between. Triggered only by an explicit button press. If Discord answers with a captcha
 * we stop and tell the user to solve it - we never try to work around it.
 *
 * A 429 is waited out and retried, because claim-reward is rate limited and a burst of
 * claims reliably trips it. Giving up on the first 429 left quests permanently stuck
 * until the limit expired on its own.
 */
export async function claimQuests(quests: Quest[], onProgress?: (done: number, total: number) => void): Promise<ClaimOutcome> {
    const outcome: ClaimOutcome = { claimed: 0, captcha: 0, failed: 0, orbs: 0, message: "" };
    if (claimInFlight || quests.length === 0) return outcome;

    claimInFlight = true;

    try {
        for (let i = 0; i < quests.length; i++) {
            const quest = quests[i];
            const result = await claimWithRateLimitRetries(quest);

            if (result.status === "claimed") {
                outcome.claimed++;
                outcome.orbs += getOrbReward(quest);
            } else if (result.status === "captcha") {
                outcome.captcha++;
            } else {
                outcome.failed++;
            }

            if (result.status !== "claimed" && result.message) outcome.message = result.message;

            // re-read the store between claims so the list does not go stale under the
            // banner, and so a claim is never fired while the previous one is settling
            refresh();
            onProgress?.(i + 1, quests.length);

            if (result.status === "captcha") break;
            if (i < quests.length - 1) await sleep(CLAIM_GAP);
        }
    } finally {
        claimInFlight = false;
    }

    if (outcome.captcha > 0) {
        showToast("Discord is asking for a captcha - solve it, then press claim again", Toasts.Type.FAILURE);
    } else if (outcome.failed > 0 && outcome.claimed === 0) {
        showToast(`Could not claim the rewards - ${outcome.message || "try again in Discord"}`, Toasts.Type.FAILURE);
    } else if (outcome.failed > 0) {
        showToast(`Claimed ${outcome.claimed} of ${outcome.claimed + outcome.failed} rewards - ${outcome.message}`, Toasts.Type.FAILURE);
    } else if (outcome.claimed > 0) {
        const orbText = outcome.orbs > 0 ? ` (${outcome.orbs} Orbs)` : "";
        showToast(`Claimed ${outcome.claimed} reward${outcome.claimed === 1 ? "" : "s"}${orbText}`, Toasts.Type.SUCCESS);
    }

    setTimeout(refresh, 1_000);
    refresh();
    return outcome;
}

/** Runs one claim, waiting out and retrying Discord rate limits */
async function claimWithRateLimitRetries(quest: Quest): Promise<ClaimResult> {
    let result = await claimOne(quest.id);

    for (let attempt = 0; result.status === "rate-limited" && attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
        const wait = Math.min(result.retryAfter + RATE_LIMIT_SLACK, MAX_RATE_LIMIT_WAIT);
        if (wait <= 0) break;

        console.warn(`[questAutoComplete] claim rate limited, waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        refresh();
        result = await claimOne(quest.id);
    }

    return result;
}

/** Re-reads the quest store right now instead of waiting for the next poll tick */
export function refresh() {
    poll();
}

function poll() {
    const questsById = new Map(getAllQuests().map(quest => [quest.id, quest]));

    for (const [id, run] of runs) {
        const quest = questsById.get(id);
        if (!quest) continue;

        if (isCompleted(quest)) {
            run.reported = run.target;
            if (run.status === "running") stopQuest(id);

            // the quest finished outside our own flow (e.g. Discord completed it),
            // still surface it so the user knows the reward is available
            if (run.status !== "done") {
                run.status = "done";
                notifyComplete(run.name, quest);
            }
            continue;
        }

        const value = getReportedProgress(quest, run.taskName);
        if (value > run.reported) {
            run.reported = value;
            run.reportedAt = Date.now();
        }

        if (run.status === "error" && value >= run.target) {
            run.status = "done";
            notifyComplete(run.name, quest);
        }
    }

    emit();
}

/**
 * Nudges the shown progress forward once a second for quests whose real value only
 * arrives on a heartbeat every ~20s. Video quests tick themselves, so skip them.
 */
function displayTick() {
    const now = Date.now();
    let changed = false;

    for (const run of runs.values()) {
        if (run.status !== "running" || run.queued) continue;
        // video quests tick themselves, achievement quests are binary and land all at once
        if (run.taskName === "WATCH_VIDEO" || run.taskName === "WATCH_VIDEO_ON_MOBILE" || run.taskName === "ACHIEVEMENT_IN_ACTIVITY") continue;

        const lead = Math.min(DISPLAY_LEAD_SECONDS, Math.max(0, (now - run.reportedAt) / 1_000));
        const estimate = Math.min(run.target, run.reported + lead);

        if (estimate > run.spoofed) {
            run.spoofed = estimate;
            changed = true;
        }
    }

    if (changed) emit();
}

let focusSpoofRestore: (() => void) | null = null;

/**
 * Claiming a reward fails while the window is in the background. While this is on the client
 * is told the window is focused and visible. Everything it touches is restored by
 * {@link disableFocusSpoof}.
 */
export function enableFocusSpoof() {
    if (focusSpoofRestore) return;

    const restores: Array<() => void> = [];

    const store = WindowStore as any;
    for (const key of ["isFocused", "isAppFocused", "isVisible"]) {
        const original = store?.[key];
        if (typeof original !== "function") continue;

        store[key] = () => true;
        restores.push(() => { store[key] = original; });
    }

    // anything that asks which window is focused still needs a non-null id
    const originalGetFocusedWindowId = store?.getFocusedWindowId;
    if (typeof originalGetFocusedWindowId === "function") {
        store.getFocusedWindowId = () => (window as any).__DISCORD_WINDOW_ID ?? originalGetFocusedWindowId.call(store);
        restores.push(() => { store.getFocusedWindowId = originalGetFocusedWindowId; });
    }

    const doc = document as any;
    const originalHasFocus = doc.hasFocus;
    if (typeof originalHasFocus === "function") {
        doc.hasFocus = () => true;
        restores.push(() => { doc.hasFocus = originalHasFocus; });
    }

    const originalVisibilityState = Object.getOwnPropertyDescriptor(doc, "visibilityState");
    const originalHidden = Object.getOwnPropertyDescriptor(doc, "hidden");
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(doc, "hidden", { configurable: true, get: () => false });
    restores.push(() => {
        if (originalVisibilityState) Object.defineProperty(doc, "visibilityState", originalVisibilityState);
        else delete doc.visibilityState;
        if (originalHidden) Object.defineProperty(doc, "hidden", originalHidden);
        else delete doc.hidden;
    });

    focusSpoofRestore = () => {
        for (const restore of restores) restore();
    };
}

export function disableFocusSpoof() {
    focusSpoofRestore?.();
    focusSpoofRestore = null;
}

export function startPolling() {
    if (pollInterval) return;
    poll();
    pollInterval = setInterval(poll, POLL_INTERVAL);
    tickInterval = setInterval(displayTick, 1_000);
}

export function stopPolling() {
    if (pollInterval) clearInterval(pollInterval);
    if (tickInterval) clearInterval(tickInterval);

    // forget anything we learned this session so re-enabling starts clean
    pollInterval = null;
    tickInterval = null;
    trackedCompletions.clear();

    // drop stale rows from a previous session; any still-running quest was aborted by stopAll()
    runs.clear();
    controllers.clear();
    claimableCache = null;
    emit();
}
