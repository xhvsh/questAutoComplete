/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";

import { disableFocusSpoof, enableFocusSpoof, startPolling, stopAll, stopPolling } from "./engine";
import { PluginInfo } from "./PluginInfo";
import { QuestButton } from "./QuestButton";
import { settings } from "./settings";

export default definePlugin({
    name: "QuestAutoComplete",
    description: "Adds a Quests button to the server rail to autocomplete your joined quests, with live progress and reward claiming",
    authors: [{ name: "xhvsh", id: 1301345826143997954n }],
    tags: ["Activity", "Organisation", "Utility"],
    settings,
    settingsAboutComponent: PluginInfo,

    // Renders through a GuildsBar patch instead of ServerListAPI, so the button is a
    // real rail item and lines up with the Favorites and DM entries. Patch based
    // plugins only take effect after a reload on first enable
    renderQuestButton: ErrorBoundary.wrap(QuestButton, { noop: true }),

    patches: [
        {
            // The rail fragment renders guilds after the Favorites conditional
            // (a?(0,X.jsx)(eS,{}):null). We hijack that conditional so the button
            // sits straight under Favorites: with favorites it gets wrapped in a
            // Fragment together with the Favorites item, without favorites it is
            // rendered in the null branch. r is this module's React alias
            find: 'location:"GuildsBar"',
            replacement: [
                {
                    match: /(?<=SERVER_RAIL_TOP&&\(0,\i\.jsx\)\(\i,\{\}\),)(\i)\?\(0,\i\.jsx\)\((\i),\{\}\):null/,
                    replace: "$1?(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)($2,{}),(0,r.jsx)($self.renderQuestButton,{})]}):(0,r.jsx)($self.renderQuestButton,{})"
                }
            ]
        }
    ],

    start() {
        // claiming a reward fails while the window is in the background, so keep the client
        // believing the window is focused while the plugin is on
        if (settings.store.spoofAppFocus) enableFocusSpoof();

        startPolling();
    },

    stop() {
        // never leave spoofed stores or pending heartbeats behind
        disableFocusSpoof();
        stopAll();
        stopPolling();
    }
});
