/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { QuestsStore } from "./questStore";
import { settings } from "./settings";
import { Quest, QuestReward, QuestTask, QuestTaskConfig, SUPPORTED_TASKS, SupportedTask } from "./types";

export function getAllQuests(): Quest[] {
    try {
        const quests = QuestsStore?.quests;
        if (!quests) return [];
        return quests instanceof Map ? [...quests.values()] : Object.values(quests);
    } catch {
        return [];
    }
}

export function getQuestName(quest: Quest): string {
    return quest.config?.messages?.questName ?? "Unknown Quest";
}

export function getTaskConfig(quest: Quest): QuestTaskConfig | undefined {
    return quest.config?.taskConfigV2 ?? quest.config?.taskConfig;
}

export function getTaskName(quest: Quest): SupportedTask | null {
    const tasks = getTaskConfig(quest)?.tasks;
    if (!tasks) return null;
    return SUPPORTED_TASKS.find(task => tasks[task] != null) ?? null;
}

export function getTaskData(quest: Quest, taskName: SupportedTask): QuestTask | undefined {
    return getTaskConfig(quest)?.tasks?.[taskName];
}

/**
 * Whether the plugin can actually drive this task type right now. Achievement quests only work
 * while their bypass is enabled, so with the setting off they count as unsupported rather than
 * showing a Start button that would refuse to run.
 */
export function isTaskRunnable(taskName: SupportedTask): boolean {
    if (taskName === "ACHIEVEMENT_IN_ACTIVITY" && !settings.store.achievementBypass) return false;
    return true;
}

export function getTarget(quest: Quest, taskName: SupportedTask): number {
    return getTaskData(quest, taskName)?.target ?? 0;
}

export function getApplicationId(quest: Quest, taskName: SupportedTask): string | undefined {
    return quest.config?.application?.id ?? getTaskData(quest, taskName)?.applications?.[0]?.id;
}

export function getApplicationName(quest: Quest, taskName: SupportedTask): string | undefined {
    return quest.config?.application?.name
        ?? getTaskData(quest, taskName)?.applications?.[0]?.name
        ?? undefined;
}

export function getReportedProgress(quest: Quest, taskName: SupportedTask): number {
    const status = quest.userStatus;
    if (!status) return 0;
    if (quest.config?.configVersion === 1) return status.streamProgressSeconds ?? 0;

    // plain object over REST, but dispatched payloads pass through Discord's own
    // transform first, which turns `progress` into a Map keyed by task name
    const progress = status.progress as any;
    const entry = progress instanceof Map ? progress.get(taskName) : progress?.[taskName];
    return entry?.value ?? 0;
}

export function isEnrolled(quest: Quest): boolean {
    return !!quest.userStatus?.enrolledAt;
}

export function isCompleted(quest: Quest): boolean {
    return !!quest.userStatus?.completedAt;
}

/** Epoch ms at which the quest ends, or 0 when it has no expiry */
export function getExpiresAt(quest: Quest): number {
    const expiresAt = quest.config?.expiresAt;
    if (!expiresAt) return 0;
    const time = new Date(expiresAt).getTime();
    return Number.isFinite(time) ? time : 0;
}

export function isExpired(quest: Quest): boolean {
    const expiresAt = getExpiresAt(quest);
    return expiresAt > 0 && expiresAt <= Date.now();
}

/** A quest ending within the next `hours` hours */
export function isExpiringSoon(quest: Quest, hours = 24): boolean {
    const expiresAt = getExpiresAt(quest);
    return expiresAt > 0 && expiresAt - Date.now() <= hours * 3_600_000;
}

/** "Ends in 3h 12m", or null when the quest has no expiry */
export function formatExpiry(quest: Quest): string | null {
    const expiresAt = getExpiresAt(quest);
    if (expiresAt <= 0) return null;
    const remaining = expiresAt - Date.now();
    return remaining <= 0 ? "Expired" : `Ends in ${formatDuration(remaining)}`;
}

function getRewards(quest: Quest): QuestReward[] {
    const { config } = quest;
    return config?.rewards ?? config?.rewardsConfig?.rewards ?? config?.rewards_config?.rewards ?? [];
}

export function hasRewards(quest: Quest): boolean {
    return getRewards(quest).length > 0;
}

/** Human readable name of the first reward, e.g. "Cybernetic Headgear" or "200 Orbs" */
export function getRewardName(quest: Quest): string | null {
    const reward = getRewards(quest)[0];
    if (!reward) return null;

    const name = reward.messages?.name ?? reward.messages?.nameWithArticle ?? reward.messages?.name_with_article ?? reward.name ?? reward.label;
    if (name) return name;

    const orbs = reward.orbQuantity ?? reward.orb_quantity;
    if (typeof orbs === "number" && orbs > 0) return `${orbs} Orbs`;

    return null;
}

/** Orbs a single quest grants across all of its rewards */
export function getOrbReward(quest: Quest): number {
    let total = 0;
    for (const reward of getRewards(quest)) {
        const orbs = reward.orbQuantity ?? reward.orb_quantity;
        if (typeof orbs === "number" && orbs > 0) total += orbs;
    }
    return total;
}

export function isRewardClaimed(quest: Quest): boolean {
    const status = quest.userStatus;
    if (!status) return true;

    // Discord sets claimedAt (and historically rewardClaimedAt) the moment the
    // reward is claimed, this is the only field we can trust
    if (status.claimedAt) return true;
    if (status.rewardClaimedAt) return true;

    // fall back to the reward state, treating every variant of "not yet claimed" as unclaimed
    const state = status.rewardState;
    if (typeof state !== "string") return false;
    if (/unclaimed|claimable|pending/i.test(state)) return false;
    return /claimed|redeemed/i.test(state);
}

/** A quest that finished and still has an unclaimed reward attached to it */
export function isClaimable(quest: Quest): boolean {
    return isCompleted(quest) && hasRewards(quest) && !isRewardClaimed(quest);
}

export interface QuestSections {
    /** enrolled, not finished, not expired, task type we know how to spoof */
    runnable: Quest[];
    /** enrolled, not finished, not expired, but a task type we cannot spoof */
    unsupported: Quest[];
    /** quests that exist but have not been joined yet */
    available: Quest[];
}

export function getQuestSections(): QuestSections {
    const sections: QuestSections = { runnable: [], unsupported: [], available: [] };

    for (const quest of getAllQuests()) {
        if (!isEnrolled(quest)) {
            if (!isExpired(quest)) sections.available.push(quest);
            continue;
        }

        if (isCompleted(quest) || isExpired(quest)) continue;

        const taskName = getTaskName(quest);
        if (!taskName || getTarget(quest, taskName) <= 0 || !isTaskRunnable(taskName)) sections.unsupported.push(quest);
        else sections.runnable.push(quest);
    }

    // soonest to expire first, so the quests you are about to lose are on top
    const byExpiry = (a: Quest, b: Quest) => (getExpiresAt(a) || Infinity) - (getExpiresAt(b) || Infinity);
    sections.runnable.sort(byExpiry);
    sections.unsupported.sort(byExpiry);
    sections.available.sort(byExpiry);

    return sections;
}

export function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds % 3600 / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

export function formatSeconds(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}
