import React, { memo } from "react";
import * as xyflow from "@xyflow/react";
import { Box, Typography } from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";
import { getDeclarations } from "../../../lib/chart-validation";

// see StateNode.jsx why the named import does not work
const { NodeResizer } = xyflow;

/**
 * A function block: square corners and a different color than states, no connection points
 *
 * @param {import("@xyflow/react").NodeProps<import("@xyflow/react").Node<{
 *     fn: import("../../../lib/chart-model").ChartFunction;
 *     problems?: string[];
 * }>>} props
 */
function FunctionNode({ data, selected }) {
    const { fn, problems } = data;
    const signatures = getDeclarations(fn.code)
        .filter(d => d.signature)
        .map(d => d.signature);
    let borderColor = "secondary.main";
    if (problems) {
        borderColor = "error.main";
    } else if (selected) {
        borderColor = "primary.main";
    }
    return (
        <>
            <NodeResizer
                isVisible={selected}
                minWidth={120}
                minHeight={50}
            />
            <Box
                title={problems?.join("\n")}
                sx={{
                    width: "100%",
                    height: "100%",
                    border: 2,
                    borderStyle: problems ? "dashed" : "solid",
                    borderColor,
                    borderRadius: 0,
                    bgcolor: "background.paper",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                }}
            >
                <Box sx={{ bgcolor: "secondary.main", color: "secondary.contrastText", px: 1, py: 0.25 }}>
                    {signatures.length ? (
                        signatures.map(signature => (
                            <Typography
                                key={signature}
                                variant="subtitle2"
                                sx={{ fontFamily: "monospace", fontWeight: "bold" }}
                                noWrap
                            >
                                {`ƒ ${signature}`}
                            </Typography>
                        ))
                    ) : (
                        <Typography
                            variant="subtitle2"
                            sx={{ fontStyle: "italic" }}
                            noWrap
                        >
                            {`ƒ ${I18n.t("Function")}`}
                        </Typography>
                    )}
                </Box>
                <Typography
                    variant="caption"
                    component="div"
                    sx={{ fontFamily: "monospace", whiteSpace: "pre", lineHeight: 1.3, px: 1, py: 0.5, opacity: 0.8 }}
                >
                    {fn.code}
                </Typography>
            </Box>
        </>
    );
}

export default memo(FunctionNode);
