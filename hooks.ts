/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

import { engine } from "./engine";

/** Re-renders the caller whenever the engine reports a change. */
export function useEngineState(): number {
    const [version, setVersion] = useState(engine.getVersion);

    useEffect(() => {
        setVersion(engine.getVersion());
        return engine.subscribe(() => setVersion(engine.getVersion()));
    }, []);

    return version;
}
