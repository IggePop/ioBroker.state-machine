import React, { useState } from "react";
import { Box, Button, IconButton, MenuItem, TextField, Tooltip, Typography } from "@mui/material";
import { Add as AddIcon, Delete as DeleteIcon, ListAlt as SelectIdIcon } from "@mui/icons-material";
import { DialogSelectID, I18n } from "@iobroker/adapter-react-v5";

/**
 * @typedef {import("../../../lib/chart-model").ChartSymbol} ChartSymbol
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Initial values of locals are entered as JSON (number, boolean, string in quotes), anything else is a string
 *
 * @param {string} text
 * @returns {any}
 */
function parseInitial(text) {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Keeps the typed text, so editing is not disturbed by converting the value back and forth
 *
 * @param {object} props
 * @param {any} props.value
 * @param {(value: any) => void} props.onChange
 */
function InitialValueField({ value, onChange }) {
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
 * @param {object} props
 * @param {ChartSymbol[]} props.symbols
 * @param {(symbols: ChartSymbol[]) => void} props.onChange
 * @param {any} props.socket
 * @param {import("@iobroker/adapter-react-v5").IobTheme} props.theme
 */
export default function SymbolsEditor({ symbols, onChange, socket, theme }) {
    /** index of the symbol for which the state selection dialog is open */
    const [selectFor, setSelectFor] = useState(/** @type {number | null} */ (null));

    /**
     * @param {number} index
     * @param {Partial<ChartSymbol>} patch
     */
    const update = (index, patch) => onChange(symbols.map((s, i) => (i === index ? { ...s, ...patch } : s)));

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
                                onChange={e =>
                                    update(index, { scope: /** @type {ChartSymbol["scope"]} */ (e.target.value) })
                                }
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
                    dialogName="state-machine"
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
