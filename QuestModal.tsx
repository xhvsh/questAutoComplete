/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useState } from "@webpack/common";

import {
    claimQuests,
    enrollQuest,
    getClaimableQuests,
    getOverallProgress,
    getRun,
    getRunningRuns,
    getRunProgress,
    isClaiming,
    isQuestRunning,
    startQuest,
    startQuests,
    stopAll,
    stopQuest,
} from "./engine";
import { useEngineState } from "./hooks";
import { QuestIcon } from "./QuestIcon";
import {
    formatDuration,
    formatExpiry,
    formatSeconds,
    getApplicationName,
    getOrbReward,
    getQuestName,
    getQuestSections,
    getReportedProgress,
    getRewardName,
    getTarget,
    getTaskName,
    isCompleted,
    isExpiringSoon,
    isTaskRunnable,
} from "./quests";
import { DESKTOP_ONLY_TASKS, type Quest, TASK_LABELS } from "./types";

const cl = classNameFactory("vc-quest-ac-");

const isDesktopApp = IS_DISCORD_DESKTOP || IS_VESKTOP;

export function openQuestModal() {
    openModal(modalProps => <QuestModal modalProps={modalProps} />);
}

function ProgressBar({ percent, error, large, done, active }: { percent: number; error?: boolean; large?: boolean; done?: boolean; active?: boolean; }) {
    const safe = Math.max(0, Math.min(100, percent));

    return (
        <div className={cl("progress", large && "progress-large")}>
            <div
                className={cl("progress-fill", error && "progress-fill-error", done && "progress-fill-done", active && "progress-fill-active")}
                style={{ width: `${safe}%` }}
            />
        </div>
    );
}

type ChipKind = "reward" | "warning";

function Chip({ kind, children }: { kind?: ChipKind; children: React.ReactNode; }) {
    return <span className={cl("chip", kind && `chip-${kind}`)}>{children}</span>;
}

function SectionHeading({ children, count }: { children: React.ReactNode; count?: number; }) {
    return (
        <div className={cl("section-head")}>
            <HeadingSecondary className={cl("section-heading")}>{children}</HeadingSecondary>
            {count != null && <span className={cl("section-count")}>{count}</span>}
        </div>
    );
}

/** Chips describing what a quest wants you to do, its reward, and how long is left */
function QuestChips({ quest, taskLabel, expiring }: { quest: Quest; taskLabel: string; expiring?: boolean; }) {
    const reward = getRewardName(quest);
    const expiry = formatExpiry(quest);

    return (
        <div className={cl("chips")}>
            <Chip>{taskLabel}</Chip>
            {reward && <Chip kind="reward">{reward}</Chip>}
            {expiry && <Chip kind={expiring ? "warning" : undefined}>{expiry}</Chip>}
        </div>
    );
}

function QuestProgressRow({ quest }: { quest: Quest; }) {
    const taskName = getTaskName(quest);
    if (!taskName) return null;

    const target = getTarget(quest, taskName);
    const run = getRun(quest.id);
    const running = isQuestRunning(quest.id);
    const done = run?.status === "done" || isCompleted(quest);
    const reported = run ? getRunProgress(run) : getReportedProgress(quest, taskName);
    const percent = target > 0 ? Math.min(100, reported / target * 100) : 0;
    const remaining = Math.max(0, target - reported);
    const applicationName = getApplicationName(quest, taskName);
    const needsDesktopApp = DESKTOP_ONLY_TASKS.has(taskName) && !isDesktopApp;
    const expiring = !done && isExpiringSoon(quest);
    const failed = run?.status === "error";

    let status: string;
    if (done) status = "Completed";
    else if (run?.status === "error") status = run.error ?? "Something went wrong";
    else if (run?.queued) status = "Waiting for another spoofed quest to finish…";
    else if (remaining === 0) status = "Ready to claim";
    else if (taskName === "ACHIEVEMENT_IN_ACTIVITY") status = "Reporting the achievement to the activity…";
    else status = `${formatSeconds(Math.floor(reported))} / ${formatSeconds(target)} · about ${formatDuration(remaining * 1_000)} left`;

    return (
        <div className={cl("quest", running && "quest-running", done && "quest-done", expiring && "quest-expiring")}>
            <div className={cl("quest-head")}>
                <div className={cl("quest-title")}>
                    <span className={cl("quest-name")}>{getQuestName(quest)}</span>
                    <QuestChips
                        quest={quest}
                        taskLabel={`${TASK_LABELS[taskName]}${applicationName ? ` · ${applicationName}` : ""}`}
                        expiring={expiring}
                    />
                </div>
                {running
                    ? <Button variant="secondary" size="small" onClick={() => stopQuest(quest.id)}>Stop</Button>
                    : <Button variant="primary" size="small" disabled={done} onClick={() => startQuest(quest)}>Start</Button>}
            </div>

            <ProgressBar percent={percent} error={failed} done={done} active={running && !done} />
            <div className={cl("quest-meta")}>
                <span className={cl("quest-status", running && !done && "quest-status-running", failed && "quest-status-error", done && "quest-status-done")}>
                    {status}
                </span>
                <span className={cl("quest-percent")}>{Math.round(percent)}%</span>
            </div>

            {needsDesktopApp && !done && (
                <span className={cl("quest-warning")}>Open this in the Discord desktop app to spoof this quest</span>
            )}
        </div>
    );
}

function SimpleQuestRow({ quest, joinable, expiring }: { quest: Quest; joinable?: boolean; expiring?: boolean; }) {
    const [joining, setJoining] = useState(false);
    const taskName = getTaskName(quest);

    const onJoin = async () => {
        setJoining(true);
        try {
            await enrollQuest(quest.id);
        } finally {
            setJoining(false);
        }
    };

    return (
        <div className={cl("quest", "quest-simple", expiring && "quest-expiring")}>
            <div className={cl("quest-head")}>
                <div className={cl("quest-title")}>
                    <span className={cl("quest-name")}>{getQuestName(quest)}</span>
                    <QuestChips
                        quest={quest}
                        taskLabel={taskName ? TASK_LABELS[taskName] : "Unsupported task type"}
                        expiring={expiring}
                    />
                    {taskName && !isTaskRunnable(taskName) && (
                        <span className={cl("quest-warning")}>Turn on achievement bypass in the plugin settings to automate this</span>
                    )}
                </div>
                {joinable && (
                    <Button variant="secondary" size="small" disabled={joining} onClick={onJoin}>
                        {joining ? "Accepting…" : "Accept Quest"}
                    </Button>
                )}
            </div>
        </div>
    );
}

function QuestModal({ modalProps }: { modalProps: RenderModalProps; }) {
    useEngineState();

    const { runnable, unsupported, available } = getQuestSections();
    const runningRuns = getRunningRuns();
    const anyRunning = runningRuns.length > 0;
    const claimable = getClaimableQuests();
    const claimableCount = claimable.length;
    const overall = getOverallProgress();
    const [claiming, setClaiming] = useState(false);
    const [claimProgress, setClaimProgress] = useState<{ done: number; total: number } | null>(null);
    const [claimNote, setClaimNote] = useState<string | null>(null);

    const claimableOrbs = claimable.reduce((sum, quest) => sum + getOrbReward(quest), 0);
    const overallRemainingMs = Math.max(0, overall.total - overall.value) * 1_000;

    const onToggleAll = () => {
        if (anyRunning) stopAll();
        else startQuests(runnable);
    };

    const onClaim = async () => {
        if (isClaiming()) return;

        setClaiming(true);
        setClaimNote(null);
        setClaimProgress({ done: 0, total: claimableCount });
        try {
            const outcome = await claimQuests(claimable, (done, total) => setClaimProgress({ done, total }));
            if (outcome.captcha > 0) setClaimNote("Discord asked for a captcha - solve it, then press claim again.");
            else if (outcome.claimed > 0) setClaimNote(`Claimed ${outcome.claimed} reward${outcome.claimed === 1 ? "" : "s"}.`);
            else if (outcome.failed > 0) setClaimNote(outcome.message ? `Could not claim - ${outcome.message}` : "Could not claim - try again from Discord's Quests page.");
        } finally {
            setClaiming(false);
            setClaimProgress(null);
        }
    };

    return (
        <Modal
            {...modalProps}
            title={<span className={cl("modal-title")}><QuestIcon />Quest Manager</span>}
            size="lg"
            subtitle="Autocomplete your joined quests"
        >
            <div className={cl("content")}>
                {overall.count > 0 && (
                    <div className={cl("overall")}>
                        <div className={cl("overall-head")}>
                            <span className={cl("overall-label")}>Overall progress</span>
                            <span className={cl("overall-value")}>{Math.round(overall.percent)}%</span>
                        </div>
                        <ProgressBar percent={overall.percent} large active={anyRunning && overall.percent < 100} />
                        <span className={cl("overall-sub")}>
                            about {formatDuration(overallRemainingMs)} left · {overall.count} quest{overall.count === 1 ? "" : "s"}
                        </span>
                    </div>
                )}

                {claimableCount > 0 && (
                    <div className={cl("banner")}>
                        <div className={cl("banner-text")}>
                            <strong className={cl("banner-title")}>
                                {claimableCount} quest reward{claimableCount === 1 ? "" : "s"} ready to claim
                            </strong>
                            <div className={cl("banner-list")}>
                                {claimable.map(quest => <span key={quest.id}>{getQuestName(quest)}</span>)}
                            </div>
                            {claimNote && <span className={cl("banner-note")}>{claimNote}</span>}
                        </div>
                        <div className={cl("banner-actions")}>
                            <Button
                                variant="primary"
                                size="small"
                                disabled={claiming || isClaiming()}
                                onClick={onClaim}
                            >
                                {claiming
                                    ? claimProgress && claimProgress.total > 1
                                        ? `Claiming ${claimProgress.done} / ${claimProgress.total}…`
                                        : "Claiming…"
                                    : claimableOrbs > 0
                                        ? `Claim ${claimableOrbs} Orbs`
                                        : `Claim ${claimableCount} reward${claimableCount === 1 ? "" : "s"}`}
                            </Button>
                        </div>
                    </div>
                )}

                <Flex alignItems="center" gap="8px">
                    <Button
                        variant={anyRunning ? "secondary" : "primary"}
                        size="small"
                        disabled={runnable.length === 0}
                        onClick={onToggleAll}
                    >
                        {anyRunning ? `Stop all (${runningRuns.length})` : `Autocomplete all (${runnable.length})`}
                    </Button>
                </Flex>

                <Divider className={cl("divider")} />

                <div className={cl("section")}>
                    <SectionHeading count={runnable.length}>Quests in progress</SectionHeading>
                    {runnable.length === 0
                        ? <Paragraph className={cl("empty")}>You have no joined quests left that can be automated.</Paragraph>
                        : runnable.map(quest => <QuestProgressRow key={quest.id} quest={quest} />)}
                </div>

                {unsupported.length > 0 && (
                    <div className={cl("section")}>
                        <SectionHeading count={unsupported.length}>Joined, but not automatable</SectionHeading>
                        {unsupported.map(quest => (
                            <SimpleQuestRow
                                key={quest.id}
                                quest={quest}
                                expiring={isExpiringSoon(quest)}
                            />
                        ))}
                    </div>
                )}

                {available.length > 0 && (
                    <div className={cl("section")}>
                        <SectionHeading count={available.length}>Available quests</SectionHeading>
                        {available.map(quest => (
                            <SimpleQuestRow
                                key={quest.id}
                                quest={quest}
                                joinable
                                expiring={isExpiringSoon(quest)}
                            />
                        ))}
                    </div>
                )}

            </div>
        </Modal>
    );
}
