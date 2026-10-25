import React, { useState } from "react";
import { Box, Button, IconButton, MenuItem, TextField, Tooltip, Typography } from "@mui/material";
import { Add as AddIcon, Delete as DeleteIcon, ListAlt as SelectIdIcon } from "@mui/icons-material";
import { DialogSelectID, I18n } from "@iobroker/adapter-react-v5";
import type { AdminConnection, IobTheme } from "@iobroker/adapter-react-v5";
import type { ChartSymbol } from "../../../src/lib/chart-model";
import { formatValue } from "./LiveValuesPanel";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Initial values of locals are entered as JSON (number, boolean, string in quotes), anything else is a string
 *
 * @param text The entered text
 */
function parseInitial(text: string): any {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Keeps the typed text, so editing is not disturbed by converting the value back and forth
 *
 * @param props Component properties
 * @param props.value The initial value
 * @param props.onChange Called with the parsed value
 */
function InitialValueField({ value, onChange }: { value: any; onChange: (value: any) => void }): React.JSX.Element {
    const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value));
    return (
        <TextField
            size="small"
            label={I18n.t("Initial value")}
            value={text}
            helperText={I18n.t("initialHelp")}
            onChange={e => {
                setText(e.target.value);
                onChange(e.target.value === "" ? undefined : parseInitial(e.target.value));
            }}
            slotProps={{ htmlInput: { style: { fontFamily: "monospace" } } }}
        />
    );
}

/**
 * When an input wakes up the chart. The default values are stored as undefined, so they do not appear in the chart.
 *
 * @param props Component properties
 * @param props.symbol The input
 * @param props.onChange Called with the changed properties
 */
function InputTriggerFields({
    symbol,
    onChange,
}: {
    symbol: ChartSymbol;
    onChange: (patch: Partial<ChartSymbol>) => void;
}): React.JSX.Element {
    return (
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <TextField
                select
                size="small"
                label={I18n.t("Wake up on")}
                value={symbol.trigger || "update"}
                onChange={e => onChange({ trigger: e.target.value === "change" ? "change" : undefined })}
                sx={{ flex: "1 1 140px" }}
            >
                <MenuItem value="update">{I18n.t("every update")}</MenuItem>
                <MenuItem value="change">{I18n.t("value changes only")}</MenuItem>
            </TextField>
            <TextField
                select
                size="small"
                label={I18n.t("Acknowledged (ack)")}
                value={symbol.ack || "any"}
                onChange={e =>
                    onChange({
                        ack: e.target.value === "any" ? undefined : (e.target.value as ChartSymbol["ack"]),
                    })
                }
                sx={{ flex: "1 1 140px" }}
            >
                <MenuItem value="any">{I18n.t("any")}</MenuItem>
                <MenuItem value="ack">{I18n.t("confirmed values only")}</MenuItem>
                <MenuItem value="command">{I18n.t("commands only")}</MenuItem>
            </TextField>
            <TextField
                size="small"
                type="number"
                label={I18n.t("Debounce (ms)")}
                value={symbol.debounceMs || ""}
                placeholder="0"
                onChange={e => {
                    const ms = parseInt(e.target.value, 10);
                    onChange({ debounceMs: ms > 0 ? ms : undefined });
                }}
                slotProps={{ htmlInput: { min: 0, step: 100 } }}
                sx={{ flex: "1 1 100px" }}
            />
            <Typography
                variant="caption"
                color="text.secondary"
                sx={{ flexBasis: "100%" }}
            >
                {I18n.t("triggerHelp")}
            </Typography>
        </Box>
    );
}

interface SymbolsEditorProps {
    symbols: ChartSymbol[];
    onChange: (symbols: ChartSymbol[]) => void;
    /** Current values of the variables, empty if the chart does not run */
    liveValues: Record<string, any>;
    socket: AdminConnection;
    theme: IobTheme;
}

/**
 * The variables of a chart
 */
export default function SymbolsEditor({
    symbols,
    onChange,
    liveValues,
    socket,
    theme,
}: SymbolsEditorProps): React.JSX.Element {
    /** index of the symbol for which the state selection dialog is open */
    const [selectFor, setSelectFor] = useState<number | null>(null);

    const update = (index: number, patch: Partial<ChartSymbol>): void =>
        onChange(symbols.map((s, i) => (i === index ? { ...s, ...patch } : s)));

    const names = symbols.map(s => s.name);

    return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Typography
                variant="body2"
                color="text.secondary"
            >
                {I18n.t("symbolsHelp")}
            </Typography>
            {symbols.map((symbol, index) => {
                const nameError = !IDENTIFIER.test(symbol.name)
                    ? I18n.t("Invalid name")
                    : names.indexOf(symbol.name) !== index
                      ? I18n.t("Name already used")
                      : "";
                return (
                    <Box
                        key={index}
                        sx={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 1,
                            pb: 2,
                            borderBottom: 1,
                            borderColor: "divider",
                        }}
                    >
                        <Box sx={{ display: "flex", gap: 1 }}>
                            <TextField
                                size="small"
                                label={I18n.t("Name")}
                                value={symbol.name}
                                error={!!nameError}
                                helperText={nameError}
                                onChange={e => update(index, { name: e.target.value })}
                                sx={{ flex: 1 }}
                                slotProps={{ htmlInput: { style: { fontFamily: "monospace" } } }}
                            />
                            <TextField
                                select
                                size="small"
                                label={I18n.t("Scope")}
                                value={symbol.scope}
                                onChange={e => update(index, { scope: e.target.value as ChartSymbol["scope"] })}
                                sx={{ width: 120 }}
                            >
                                <MenuItem value="input">{I18n.t("Input")}</MenuItem>
                                <MenuItem value="output">{I18n.t("Output")}</MenuItem>
                                <MenuItem value="local">{I18n.t("Local")}</MenuItem>
                            </TextField>
                            <Tooltip title={I18n.t("Delete")}>
                                <IconButton
                                    size="small"
                                    onClick={() => onChange(symbols.filter((_, i) => i !== index))}
                                >
                                    <DeleteIcon />
                                </IconButton>
                            </Tooltip>
                        </Box>
                        {symbol.scope === "local" ? (
                            <InitialValueField
                                value={symbol.initial}
                                onChange={initial => update(index, { initial })}
                            />
                        ) : (
                            <Box sx={{ display: "flex", gap: 1 }}>
                                <TextField
                                    size="small"
                                    label={I18n.t("State ID")}
                                    value={symbol.stateId || ""}
                                    onChange={e => update(index, { stateId: e.target.value })}
                                    sx={{ flex: 1 }}
                                />
                                <Tooltip title={I18n.t("Select state")}>
                                    <IconButton
                                        size="small"
                                        onClick={() => setSelectFor(index)}
                                    >
                                        <SelectIdIcon />
                                    </IconButton>
                                </Tooltip>
                            </Box>
                        )}
                        {symbol.name in liveValues && (
                            <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
                            >
                                {I18n.t("currentValue", formatValue(liveValues[symbol.name]))}
                            </Typography>
                        )}
                        {symbol.scope === "input" && (
                            <InputTriggerFields
                                symbol={symbol}
                                onChange={patch => update(index, patch)}
                            />
                        )}
                    </Box>
                );
            })}
            <Button
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => {
                    let i = symbols.length + 1;
                    while (names.includes(`var${i}`)) {
                        i++;
                    }
                    onChange([...symbols, { name: `var${i}`, scope: "input", stateId: "" }]);
                }}
            >
                {I18n.t("Add variable")}
            </Button>
            {selectFor !== null && (
                <DialogSelectID
                    socket={socket}
                    theme={theme}
                    themeType={theme.palette.mode}
                    imagePrefix="../.."
                    dialogName="statechart"
                    types={["state"]}
                    selected={symbols[selectFor]?.stateId || ""}
                    onClose={() => setSelectFor(null)}
                    onOk={selected => {
                        const id = Array.isArray(selected) ? selected[0] : selected;
                        if (id) {
                            update(selectFor, { stateId: id });
                        }
                        setSelectFor(null);
                    }}
                />
            )}
        </Box>
    );
}
