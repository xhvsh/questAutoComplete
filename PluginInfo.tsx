/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";

const cl = classNameFactory("vc-quest-ac-");

/** Rendered on the plugin's details page between the authors and the settings */
export function PluginInfo() {
    return (
        <div className={cl("about")}>
            <Paragraph size="sm">
                The rail button opens your Quest Manager, which reads Discord's own quest store.
                Requests are only sent once you press a button in there, and captchas are never
                solved for you.
            </Paragraph>

            <Paragraph size="sm">
                <strong>Automatable:</strong> <code>WATCH_VIDEO</code>, <code>WATCH_VIDEO_ON_MOBILE</code>,{" "}
                <code>PLAY_ON_DESKTOP</code>, <code>STREAM_ON_DESKTOP</code>, <code>PLAY_ACTIVITY</code> and{" "}
                <code>ACHIEVEMENT_IN_ACTIVITY</code>. <code>PLAY_ON_DESKTOP</code>,{" "}
                <code>STREAM_ON_DESKTOP</code> and <code>ACHIEVEMENT_IN_ACTIVITY</code> need the desktop
                app. <code>ACHIEVEMENT_IN_ACTIVITY</code> briefly authorizes the activity to your account,
                reports the progress, and revokes the authorization again.
            </Paragraph>

            <Paragraph size="sm">
                <strong>Not automatable:</strong> <code>ACHIEVEMENT_IN_GAME</code> and{" "}
                <code>PLAY_ON_XBOX</code> / <code>PLAY_ON_PLAYSTATION</code>. The client has no endpoint
                that reports an in-game achievement, and the last two only exist on console.
            </Paragraph>

            <Paragraph size="sm" className={cl("about-warning")}>
                Automating Quests is against the Discord Terms of Service, and Discord has been
                enforcing it. Reported consequences include losing unclaimed Orbs, a two week ban
                on completing Quests, having Quest access revoked entirely, or wider account
                restrictions. If Discord warns you or a Quest suddenly disappears, stop using
                this plugin.
            </Paragraph>
        </div>
    );
}
