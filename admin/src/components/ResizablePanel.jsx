import React, { useRef, useState } from "react";
import { Box } from "@mui/material";

/**
 * @param {string} key
 * @param {number} defaultWidth
 * @returns {number}
 */
function loadWidth(key, defaultWidth) {
    try {
        const width = parseInt(window.localStorage.getItem(key) || "", 10);
        return Number.isFinite(width) ? width : defaultWidth;
    } catch {
        return defaultWidth;
    }
}

/**
 * @param {string} key
 * @param {number} width
 */
function saveWidth(key, width) {
    try {
        window.localStorage.setItem(key, String(width));
    } catch {
        // the width is only a convenience, it does not matter if it cannot be stored
    }
}

/**
 * A column with a fixed width which can be changed by dragging its inner border.
 * The width is remembered in the browser.
 *
 * @param {object} props
 * @param {"left" | "right"} props.side Side of the screen the panel is on, the drag handle is on the opposite side
 * @param {string} props.storageKey Key to remember the width
 * @param {number} props.defaultWidth
 * @param {number} props.minWidth
 * @param {number} props.maxWidth
 * @param {React.ReactNode} props.children
 */
export default function ResizablePanel({ side, storageKey, defaultWidth, minWidth, maxWidth, children }) {
    const [width, setWidth] = useState(() =>
        Math.min(maxWidth, Math.max(minWidth, loadWidth(storageKey, defaultWidth))),
    );
    /** @type {React.MutableRefObject<{ startX: number; startWidth: number } | null>} */
    const drag = useRef(null);

    /**
     * @param {React.PointerEvent<HTMLDivElement>} e
     */
    const onPointerDown = e => {
        e.preventDefault();
        // keep receiving the pointer events even if the pointer leaves the handle
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width };
    };

    /**
     * @param {React.PointerEvent<HTMLDivElement>} e
     */
    const onPointerMove = e => {
        if (!drag.current) {
            return;
        }
        const delta = e.clientX - drag.current.startX;
        const newWidth = drag.current.startWidth + (side === "left" ? delta : -delta);
        setWidth(Math.min(maxWidth, Math.max(minWidth, newWidth)));
    };

    const onPointerUp = () => {
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
