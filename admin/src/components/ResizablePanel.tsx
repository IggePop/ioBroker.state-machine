import React, { useRef, useState } from "react";
import { Box } from "@mui/material";

function loadWidth(key: string, defaultWidth: number): number {
    try {
        const width = parseInt(window.localStorage.getItem(key) || "", 10);
        return Number.isFinite(width) ? width : defaultWidth;
    } catch {
        return defaultWidth;
    }
}

function saveWidth(key: string, width: number): void {
    try {
        window.localStorage.setItem(key, String(width));
    } catch {
        // the width is only a convenience, it does not matter if it cannot be stored
    }
}

interface ResizablePanelProps {
    /** Side of the screen the panel is on, the drag handle is on the opposite side */
    side: "left" | "right";
    /** Key to remember the width */
    storageKey: string;
    defaultWidth: number;
    minWidth: number;
    maxWidth: number;
    children: React.ReactNode;
}

/**
 * A column with a fixed width which can be changed by dragging its inner border.
 * The width is remembered in the browser.
 */
export default function ResizablePanel({
    side,
    storageKey,
    defaultWidth,
    minWidth,
    maxWidth,
    children,
}: ResizablePanelProps): React.JSX.Element {
    const [width, setWidth] = useState(() =>
        Math.min(maxWidth, Math.max(minWidth, loadWidth(storageKey, defaultWidth))),
    );
    const drag = useRef<{ startX: number; startWidth: number } | null>(null);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
        e.preventDefault();
        // keep receiving the pointer events even if the pointer leaves the handle
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width };
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
        if (!drag.current) {
            return;
        }
        const delta = e.clientX - drag.current.startX;
        const newWidth = drag.current.startWidth + (side === "left" ? delta : -delta);
        setWidth(Math.min(maxWidth, Math.max(minWidth, newWidth)));
    };

    const onPointerUp = (): void => {
        if (drag.current) {
            drag.current = null;
            saveWidth(storageKey, width);
        }
    };

    const handle = (
        <Box
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => {
                setWidth(defaultWidth);
                saveWidth(storageKey, defaultWidth);
            }}
            sx={{
                width: 5,
                flexShrink: 0,
                cursor: "col-resize",
                touchAction: "none",
                bgcolor: "divider",
                transition: "background-color 0.2s",
                "&:hover, &:active": { bgcolor: "primary.main" },
            }}
        />
    );

    return (
        <>
            {side === "right" && handle}
            <Box sx={{ width, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>{children}</Box>
            {side === "left" && handle}
        </>
    );
}
