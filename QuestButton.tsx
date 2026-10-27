/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Tooltip } from "@webpack/common";

import { getClaimableCount, getRunningProgress, getRunningRuns, getRunProgress } from "./engine";
import { useEngineState } from "./hooks";
import { QuestIcon } from "./QuestIcon";
import { openQuestModal } from "./QuestModal";
import { formatDuration } from "./quests";

const cl = classNameFactory("vc-quest-ac-button-");

/** Subscribes on its own so the tooltip keeps ticking even while it is open */
function QuestTooltipContent() {
    useEngineState();

    const claimable = getClaimableCount();
    const running = getRunningRuns();

    if (running.length === 0) {
        return (
            <>
                <div className={cl("tooltip-title")}>Quest Manager</div>
                <div className={cl("tooltip-line")}>
                    {claimable > 0
                        ? `${claimable} reward${claimable === 1 ? "" : "s"} to claim`
                        : "No quests running"}
                </div>
            </>
        );
    }

    const progress = getRunningProgress();
    const waiting = running.filter(run => run.queued).length;
    const remaining = Math.max(0, ...running.map(run => Math.max(0, run.target - getRunProgress(run))));

    return (
        <>
            <div className={cl("tooltip-title")}>Quest Manager</div>
            <div className={cl("tooltip-line")}>
                {running.length} running · {Math.round(progress)}% · ~{formatDuration(remaining * 1_000)} left{waiting > 0 ? ` · ${waiting} waiting` : ""}
            </div>
        </>
    );
}

/** Isolated from the tooltip so its per-second updates do not churn the popout */
function QuestCircle() {
    useEngineState();

    const running = getRunningRuns();
    const progress = getRunningProgress();
    const active = running.length > 0 && progress < 100;

    return (
        <div className={cl("circle", { active })}>
            {active && <span className={cl("fill")} style={{ height: `${progress}%` }} />}
            <QuestIcon className={cl("icon")} />
        </div>
    );
}

function QuestBadge() {
    useEngineState();

    return getClaimableCount() > 0 ? <span className={cl("badge")} /> : null;
}

export function QuestButton() {
    return (
        <Tooltip
            text={<QuestTooltipContent />}
            position="right"
            aria-label="Quest Manager"
            tooltipContentClassName={cl("tooltip")}
        >
            {tooltipProps => (
                <div
                    {...tooltipProps}
                    role="button"
                    tabIndex={0}
                    className={cl("root")}
                    onClick={openQuestModal}
                    onKeyDown={event => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openQuestModal();
                        }
                    }}
                >
                    <div className={cl("wrap")}>
                        <QuestCircle />
                        <QuestBadge />
                    </div>
                </div>
            )}
        </Tooltip>
    );
}
