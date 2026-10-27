/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SUPPORTED_TASKS = [
    "WATCH_VIDEO",
    "WATCH_VIDEO_ON_MOBILE",
    "PLAY_ON_DESKTOP",
    "STREAM_ON_DESKTOP",
    "PLAY_ACTIVITY",
    "ACHIEVEMENT_IN_ACTIVITY",
] as const;

export type SupportedTask = (typeof SUPPORTED_TASKS)[number];

export const TASK_LABELS: Record<SupportedTask, string> = {
    WATCH_VIDEO: "Watch a video",
    WATCH_VIDEO_ON_MOBILE: "Watch a video on mobile",
    PLAY_ON_DESKTOP: "Play the game on desktop",
    STREAM_ON_DESKTOP: "Stream the game on desktop",
    PLAY_ACTIVITY: "Play an activity",
    ACHIEVEMENT_IN_ACTIVITY: "Earn an achievement in an activity",
};

/** Tasks that only work inside the Discord desktop app */
export const DESKTOP_ONLY_TASKS: ReadonlySet<string> = new Set([
    "PLAY_ON_DESKTOP",
    "STREAM_ON_DESKTOP",
    // the achievement report round-trips through the native module, which the web client has not
    "ACHIEVEMENT_IN_ACTIVITY",
]);

export interface QuestTask {
    /** Amount of seconds the quest needs */
    target: number;
    applications?: Array<{ id: string; name?: string; }>;
}

export interface QuestTaskConfig {
    tasks: Record<string, QuestTask | undefined>;
}

export interface QuestReward {
    type?: string | number;
    skuId?: string;
    sku_id?: string;
    label?: string;
    name?: string;
    messages?: {
        name?: string;
        nameWithArticle?: string;
        name_with_article?: string;
    };
    orbQuantity?: number;
    orb_quantity?: number;
}

export interface QuestRewardsConfig {
    rewards?: QuestReward[];
}

export interface QuestConfig {
    messages?: {
        questName?: string;
        companionQuestName?: string;
    };
    expiresAt?: string;
    configVersion?: number;
    application?: { id: string; name?: string; };
    taskConfig?: QuestTaskConfig;
    taskConfigV2?: QuestTaskConfig;
    rewards?: QuestReward[];
    rewardsConfig?: QuestRewardsConfig;
    rewards_config?: QuestRewardsConfig;
    progressBar?: Record<string, number>;
}

export interface QuestUserStatus {
    enrolledAt?: string | null;
    completedAt?: string | null;
    /** timestamp set once the reward was claimed */
    claimedAt?: string | null;
    progress?: Record<string, { value: number; } | undefined>;
    streamProgressSeconds?: number;
    rewardClaimedAt?: string | null;
    rewardState?: string | null;
}

export interface Quest {
    id: string;
    config?: QuestConfig;
    userStatus?: QuestUserStatus;
}
