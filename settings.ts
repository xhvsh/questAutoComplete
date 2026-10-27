/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    notifyOnComplete: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when a quest finishes",
        default: true
    },
    spoofAppFocus: {
        type: OptionType.BOOLEAN,
        description: "Pretend the window is always focused. Claiming a reward fails while the window is in the background, so leave this on if claiming fails when you alt tab away",
        default: true
    },
    videoProgressStep: {
        type: OptionType.SLIDER,
        description: "How much video progress to send in one request. Lower values send more requests, higher values send fewer",
        markers: [1, 5, 7, 15, 30],
        default: 7
    },
    achievementBypass: {
        type: OptionType.BOOLEAN,
        description: "Complete ACHIEVEMENT_IN_ACTIVITY quests by reporting the progress through the activity backend. Turn it off if Discord warns you about your Quest access",
        default: true
    }
});
