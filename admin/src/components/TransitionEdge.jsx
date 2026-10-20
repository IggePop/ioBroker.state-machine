import React, { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position } from "@xyflow/react";
import { Box } from "@mui/material";

/** Unit vectors pointing away from the node for each handle side */
const DIRECTIONS = {
    [Position.Top]: [0, -1],
    [Position.Right]: [1, 0],
    [Position.Bottom]: [0, 1],
    [Position.Left]: [-1, 0],
};

/**
 * Path of a self transition: a loop which leaves and enters the state on the side of the handles
 *
 * @param {number} sx
 * @param {number} sy
 * @param {number} tx
 * @param {number} ty
 * @param {Position} side
 * @returns {[string, number, number]} path, label x, label y
 */
function getLoopPath(sx, sy, tx, ty, side) {
    const [dx, dy] = DIRECTIONS[side];
    // perpendicular to the direction, so the loop gets a width
    const [px, py] = [-dy, dx];
    const out = 60;
    const width = 35;
    const path =
        `M ${sx} ${sy} ` +
        `C ${sx + dx * out + px * width} ${sy + dy * out + py * width}, ` +
        `${tx + dx * out - px * width} ${ty + dy * out - py * width}, ${tx} ${ty}`;
    return [path, (sx + tx) / 2 + dx * out * 0.75, (sy + ty) / 2 + dy * out * 0.75];
}

/**
 * @param {import("@xyflow/react").EdgeProps<import("@xyflow/react").Edge<{
 *     transition: import("../../../lib/chart-model").ChartTransition;
 *     showPriority?: boolean;
 *     problems?: string[];
 * }>>} props
 */
function TransitionEdge(props) {
    const {
        source,
        target,
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        markerEnd,
        style,
        data,
    } = props;
    const transition = data?.transition;

    const [path, labelX, labelY] =
        source === target
            ? getLoopPath(sourceX, sourceY, targetX, targetY, sourcePosition)
            : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

    const error = data?.problems?.join("\n");
    const text = `${data?.showPriority ? `${transition?.priority ?? "?"}: ` : ""}${transition?.label || ""}`;

    return (
        <>
            <BaseEdge
                path={path}
                markerEnd={markerEnd}
                style={style}
            />
            {text && (
                <EdgeLabelRenderer>
                    <Box
                        className="nodrag nopan"
                        title={error || undefined}
                        sx={{
                            position: "absolute",
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                            pointerEvents: "all",
                            bgcolor: "background.paper",
                            color: error ? "error.main" : "text.primary",
                            border: 1,
                            borderColor: error ? "error.main" : "transparent",
                            borderRadius: 1,
                            px: 0.5,
                            fontFamily: "monospace",
                            fontSize: 12,
                            whiteSpace: "pre",
                        }}
                    >
                        {text}
                    </Box>
                </EdgeLabelRenderer>
            )}
        </>
    );
}

export default memo(TransitionEdge);
