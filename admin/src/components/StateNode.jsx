import React, { memo } from "react";
import * as xyflow from "@xyflow/react";
import { Box, Typography } from "@mui/material";
import CommentBadge from "./CommentBadge";

// @xyflow/react exports "Handle" as component and as type, a named import fails the type check in JS files
const { Handle, NodeResizer, Position } = xyflow;

/** One connection point per side, in loose connection mode each of them can start and end transitions */
const SIDES = [
    ["top", Position.Top],
    ["right", Position.Right],
    ["bottom", Position.Bottom],
    ["left", Position.Left],
];

const ACTIONS = ["entry", "during", "exit"];

/**
 * Default transition marker (dot with arrow) shown left of the initial state
 */
function InitialMarker() {
    return (
        <Box
            component="svg"
            width={40}
            height={20}
            sx={{ position: "absolute", left: -42, top: 8, color: "text.primary", pointerEvents: "none" }}
        >
            <circle
                cx={5}
                cy={10}
                r={4}
                fill="currentColor"
            />
            <line
                x1={9}
                y1={10}
                x2={34}
                y2={10}
                stroke="currentColor"
                strokeWidth={2}
            />
            <polygon
                points="40,10 32,5 32,15"
                fill="currentColor"
            />
        </Box>
    );
}

/**
 * @param {import("@xyflow/react").NodeProps<import("@xyflow/react").Node<{
 *     state: import("../../../lib/chart-model").ChartState;
 *     isInitial?: boolean;
 *     isActive?: boolean;
 *     isDropTarget?: boolean;
 *     problems?: string[];
 * }>>} props
 */
function StateNode({ data, selected }) {
    const { state, isInitial, isActive, isDropTarget, problems } = data;
    let borderColor = "text.secondary";
    if (isDropTarget) {
        borderColor = "primary.main";
    } else if (isActive) {
        borderColor = "success.main";
    } else if (problems) {
        borderColor = "error.main";
    } else if (selected) {
        borderColor = "primary.main";
    }
    return (
        <>
            <NodeResizer
                isVisible={selected}
                minWidth={100}
                minHeight={50}
            />
            {isInitial && <InitialMarker />}
            <Box
                title={problems?.join("\n")}
                sx={{
                    width: "100%",
                    height: "100%",
                    border: isActive || isDropTarget ? 3 : 2,
                    borderStyle: problems && !isActive && !isDropTarget ? "dashed" : "solid",
                    borderColor,
                    borderRadius: 3,
                    // a state shows that the dragged state is moved into it when it is dropped
                    bgcolor: isDropTarget ? "action.selected" : "background.paper",
                    boxShadow: isActive ? 6 : 0,
                    px: 1,
                    py: 0.5,
                    overflow: "hidden",
                }}
            >
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <Typography
                        variant="subtitle2"
                        sx={{ fontWeight: "bold", flex: 1, minWidth: 0 }}
                        noWrap
                    >
                        {state.name}
                    </Typography>
                    <CommentBadge comment={state.comment} />
                </Box>
                {ACTIONS.filter(action => state[action]).map(action => (
                    <Typography
                        key={action}
                        variant="caption"
                        component="div"
                        sx={{ fontFamily: "monospace", whiteSpace: "pre", lineHeight: 1.3 }}
                    >
                        {`${action}: ${state[action]}`}
                    </Typography>
                ))}
            </Box>
            {SIDES.map(([side, position]) => (
                <Handle
                    key={side}
                    id={side}
                    type="source"
                    position={/** @type {import("@xyflow/react").Position} */ (position)}
                />
            ))}
        </>
    );
}

export default memo(StateNode);
