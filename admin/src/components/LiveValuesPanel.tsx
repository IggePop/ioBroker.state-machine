import React from "react";
import { Box, Typography } from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";
import type { ChartSymbol } from "../../../src/lib/chart-model";

/** Longer values are shortened, the full value is shown as tooltip */
const MAX_LENGTH = 40;

/**
 * @param value A value of a variable
 * @returns the value as JSON, undefined as "undefined"
 */
export function formatValue(value: any): string {
    return value === undefined ? "undefined" : JSON.stringify(value);
}

/**
 * The current values of the variables of the running chart, shown on the canvas
 *
 * @param props Component properties
 * @param props.symbols The variables of the chart in the editor
 * @param props.values The values published by the adapter, empty if the chart does not run
 */
export default function LiveValuesPanel({
    symbols,
    values,
}: {
    symbols: ChartSymbol[];
    values: Record<string, any>;
}): React.JSX.Element {
    const running = Object.keys(values).length > 0;
    return (
        <Box
            className="nodrag nopan nowheel"
            sx={{
                bgcolor: "background.paper",
                color: "text.primary",
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                boxShadow: 2,
                px: 1,
                py: 0.5,
                maxWidth: 360,
                maxHeight: "40vh",
                overflow: "auto",
            }}
        >
            <Typography
                variant="caption"
                color="text.secondary"
                component="div"
            >
                {I18n.t("Live values")}
            </Typography>
            {!running ? (
                <Typography
                    variant="body2"
                    sx={{ fontStyle: "italic" }}
                >
                    {I18n.t("The chart does not run")}
                </Typography>
            ) : (
                <Box
                    component="table"
                    sx={{ borderCollapse: "collapse", fontFamily: "monospace", fontSize: 12 }}
                >
                    <tbody>
                        {symbols.map(symbol => {
                            const text = symbol.name in values ? formatValue(values[symbol.name]) : "-";
                            return (
                                <tr key={symbol.name}>
                                    <Box
                                        component="td"
                                        sx={{ pr: 1, color: "text.secondary", whiteSpace: "nowrap" }}
                                        title={I18n.t(
                                            symbol.scope === "input"
                                                ? "Input"
                                                : symbol.scope === "output"
                                                  ? "Output"
                                                  : "Local",
                                        )}
                                    >
                                        {symbol.name}
                                    </Box>
                                    <Box
                                        component="td"
                                        sx={{ whiteSpace: "nowrap" }}
                                        title={text.length > MAX_LENGTH ? text : undefined}
                                    >
                                        {text.length > MAX_LENGTH ? `${text.substring(0, MAX_LENGTH)}…` : text}
                                    </Box>
                                </tr>
                            );
                        })}
                    </tbody>
                </Box>
            )}
        </Box>
    );
}
