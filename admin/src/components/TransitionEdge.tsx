import React, { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position } from "@xyflow/react";
import type { Edge, EdgeProps } from "@xyflow/react";
import { Box } from "@mui/material";
import type { ChartTransition } from "../../../src/lib/chart-model";
import CommentBadge from "./CommentBadge";

/** Unit vectors pointing away from the node for each handle side */
const DIRECTIONS: Record<Position, [number, number]> = {
    [Position.Top]: [0, -1],
    [Position.Right]: [1, 0],
    [Position.Bottom]: [0, 1],
    [Position.Left]: [-1, 0],
};

/** The other side of a node */
const OPPOSITE: Record<Position, Position> = {
    [Position.Top]: Position.Bottom,
    [Position.Right]: Position.Left,
    [Position.Bottom]: Position.Top,
    [Position.Left]: Position.Right,
};

/**
 * Path of a self transition: a loop which leaves and enters the state on the side of the handles
 *
 * @param sx Start x
 * @param sy Start y
 * @param tx End x
 * @param ty End y
 * @param side Side of the state the loop is on
 * @returns path, label x, label y
 */
function getLoopPath(sx: number, sy: number, tx: number, ty: number, side: Position): [string, number, number] {
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

type TransitionEdgeProps = EdgeProps<
    Edge<{
        transition: ChartTransition;
        showPriority?: boolean;
        inner?: boolean;
        /** the transition was just taken by the running chart */
        flash?: boolean;
        problems?: string[];
    }>
>;

function TransitionEdge(props: TransitionEdgeProps): React.JSX.Element {
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
            : getBezierPath({
                  sourceX,
                  sourceY,
                  // an inner transition starts at the border of its parent and goes into it, not out of it
                  sourcePosition: data?.inner ? OPPOSITE[sourcePosition] : sourcePosition,
                  targetX,
                  targetY,
                  targetPosition,
              });

    const error = data?.problems?.join("\n");
    const text = `${data?.showPriority ? `${transition?.priority ?? "?"}: ` : ""}${transition?.label || ""}`;

    return (
        <>
            <BaseEdge
                path={path}
                markerEnd={markerEnd}
                // the keyframes are defined in ChartEditor
                style={data?.flash ? { ...style, animation: "statechart-flash 1.5s ease-out" } : style}
            />
            {data?.inner && (
                // inner transitions start with a dot, like in other statechart tools
                <circle
                    cx={sourceX}
                    cy={sourceY}
                    r={4}
                    style={{ fill: "var(--xy-edge-stroke, var(--xy-edge-stroke-default))" }}
                />
            )}
            {(text || transition?.comment?.trim()) && (
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
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                        }}
                    >
                        {text}
                        <CommentBadge comment={transition?.comment} />
                    </Box>
                </EdgeLabelRenderer>
            )}
        </>
    );
}

export default memo(TransitionEdge);
