import React, { useMemo } from "react";
import { Box, Button, Checkbox, FormControlLabel, Switch, TextField, Typography } from "@mui/material";
import { Delete as DeleteIcon } from "@mui/icons-material";
import { I18n } from "@iobroker/adapter-react-v5";
import { GLOBALS, validateChart, validateCode, validateTransitionLabel } from "../../../lib/chart-validation";
import CodeEditor from "./CodeEditor";

/**
 * @typedef {import("../../../lib/chart-model").Chart} Chart
 * @typedef {import("../../../lib/chart-model").ChartFunction} ChartFunction
 * @typedef {import("../../../lib/chart-model").ChartState} ChartState
 * @typedef {import("../../../lib/chart-model").ChartSymbol} ChartSymbol
 * @typedef {import("../../../lib/chart-model").ChartTransition} ChartTransition
 * @typedef {import("../../../lib/chart-validation").Declaration} Declaration
 * @typedef {ReturnType<typeof useCodeTools>} CodeTools
 */

/**
 * Validation and completion for the code editors, depending on the variables and functions of the chart
 *
 * @param {ChartSymbol[]} symbols
 * @param {ChartFunction[]} functions The current function blocks
 * @param {Declaration[]} declarations Names declared in all function blocks
 */
function useCodeTools(symbols, functions, declarations) {
    return useMemo(() => {
        const functionNames = declarations.map(d => d.name);
        return {
            validateAction: (/** @type {string} */ code) => validateCode(code, "statements", symbols, 0, functionNames),
            validateLabel: (/** @type {string} */ label) => validateTransitionLabel(label, symbols, functionNames),
            /**
             * Function blocks are also checked against each other (e.g. duplicate names), so the whole chart is
             * validated with the edited code
             *
             * @param {string} id
             */
            validateFunction: id => (/** @type {string} */ code) =>
                validateChart({
                    version: 1,
                    name: "",
                    enabled: true,
                    symbols,
                    states: [],
                    transitions: [],
                    functions: functions.map(fn => (fn.id === id ? { ...fn, code } : fn)),
                })
                    .filter(p => p.id === id)
                    .map(p => p.diagnostic),
            completions: [
                ...symbols.map(s => ({
                    label: s.name,
                    detail: I18n.t(s.scope === "input" ? "Input" : s.scope === "output" ? "Output" : "Local"),
                })),
                ...declarations.map(d => ({ label: d.name, detail: d.signature || "" })),
                ...[...GLOBALS].map(name => ({ label: name })),
                { label: "after", detail: "after(5, sec)" },
            ],
        };
    }, [symbols, functions, declarations]);
}

/**
 * @param {object} props
 * @param {ChartState} props.state
 * @param {CodeTools} props.tools
 * @param {boolean} props.isInitial
 * @param {(patch: Partial<ChartState>) => void} props.onChange
 * @param {() => void} props.onSetInitial
 * @param {() => void} props.onDelete
 */
function StateProperties({ state, tools, isInitial, onChange, onSetInitial, onDelete }) {
    return (
        <>
            <Typography variant="h6">{I18n.t("State")}</Typography>
            <TextField
                size="small"
                label={I18n.t("Name")}
                value={state.name}
                onChange={e => onChange({ name: e.target.value })}
            />
            <FormControlLabel
                control={
                    <Checkbox
                        checked={isInitial}
                        disabled={isInitial}
                        onChange={onSetInitial}
                    />
                }
                label={I18n.t("Initial state")}
            />
            {
                /** @type {const} */ (["entry", "during", "exit"]).map(action => (
                    <CodeEditor
                        key={action}
                        label={action}
                        placeholder={action === "entry" ? "light = true;" : ""}
                        value={state[action] || ""}
                        onChange={value => onChange({ [action]: value })}
                        validate={tools.validateAction}
                        completions={tools.completions}
                    />
                ))
            }
            <Typography
                variant="body2"
                color="text.secondary"
            >
                {I18n.t("actionsHelp")}
            </Typography>
            <Button
                color="error"
                variant="outlined"
                startIcon={<DeleteIcon />}
                onClick={onDelete}
            >
                {I18n.t("Delete state")}
            </Button>
        </>
    );
}

/**
 * @param {object} props
 * @param {ChartTransition} props.transition
 * @param {CodeTools} props.tools
 * @param {(patch: Partial<ChartTransition>) => void} props.onChange
 * @param {() => void} props.onDelete
 */
function TransitionProperties({ transition, tools, onChange, onDelete }) {
    return (
        <>
            <Typography variant="h6">{I18n.t("Transition")}</Typography>
            <CodeEditor
                label={I18n.t("Label")}
                placeholder="event[condition]{action}"
                value={transition.label || ""}
                onChange={label => onChange({ label })}
                validate={tools.validateLabel}
                completions={tools.completions}
                helperText={I18n.t("labelHelp")}
                minRows={3}
            />
            <TextField
                size="small"
                type="number"
                label={I18n.t("Priority")}
                value={transition.priority ?? ""}
                helperText={I18n.t("priorityHelp")}
                onChange={e => onChange({ priority: e.target.value === "" ? undefined : parseInt(e.target.value, 10) })}
            />
            <Button
                color="error"
                variant="outlined"
                startIcon={<DeleteIcon />}
                onClick={onDelete}
            >
                {I18n.t("Delete transition")}
            </Button>
        </>
    );
}

/**
 * @param {object} props
 * @param {ChartFunction} props.fn
 * @param {CodeTools} props.tools
 * @param {(patch: Partial<ChartFunction>) => void} props.onChange
 * @param {() => void} props.onDelete
 */
function FunctionProperties({ fn, tools, onChange, onDelete }) {
    const validate = useMemo(() => tools.validateFunction(fn.id), [tools, fn.id]);
    return (
        <>
            <Typography variant="h6">{I18n.t("Function")}</Typography>
            <CodeEditor
                label={I18n.t("Code")}
                placeholder="function myFunction(value) { return value; }"
                value={fn.code}
                onChange={code => onChange({ code })}
                validate={validate}
                completions={tools.completions}
                helperText={I18n.t("functionHelp")}
                minRows={16}
            />
            <Button
                color="error"
                variant="outlined"
                startIcon={<DeleteIcon />}
                onClick={onDelete}
            >
                {I18n.t("Delete function")}
            </Button>
        </>
    );
}

/**
 * @param {object} props
 * @param {Chart} props.chart
 * @param {(patch: Partial<Chart>) => void} props.onChange
 */
function ChartProperties({ chart, onChange }) {
    return (
        <>
            <Typography variant="h6">{I18n.t("Chart")}</Typography>
            <TextField
                size="small"
                label={I18n.t("Name")}
                value={chart.name}
                onChange={e => onChange({ name: e.target.value })}
            />
            <FormControlLabel
                control={
                    <Switch
                        checked={chart.enabled}
                        onChange={e => onChange({ enabled: e.target.checked })}
                    />
                }
                label={I18n.t("Enabled")}
            />
            <Typography
                variant="body2"
                color="text.secondary"
            >
                {I18n.t("chartHelp")}
            </Typography>
        </>
    );
}

/**
 * Shows the properties of the selected state, transition or function block, or of the chart if nothing is selected
 *
 * @param {object} props
 * @param {Chart} props.chart Chart level properties, states/transitions/functions may be outdated
 * @param {ChartState | null} props.selectedState
 * @param {ChartTransition | null} props.selectedTransition
 * @param {ChartFunction | null} props.selectedFunction
 * @param {ChartFunction[]} props.functions The current function blocks
 * @param {Declaration[]} props.declarations Names declared in all function blocks
 * @param {(patch: Partial<Chart>) => void} props.onChartChange
 * @param {(id: string, patch: Partial<ChartState>) => void} props.onStateChange
 * @param {(id: string, patch: Partial<ChartTransition>) => void} props.onTransitionChange
 * @param {(id: string, patch: Partial<ChartFunction>) => void} props.onFunctionChange
 * @param {(id: string) => void} props.onDeleteNode Deletes a state or function block
 * @param {(id: string) => void} props.onDeleteTransition
 */
export default function PropertiesPanel(props) {
    const { chart, selectedState, selectedTransition, selectedFunction, functions, declarations } = props;
    const tools = useCodeTools(chart.symbols, functions, declarations);
    let content;
    if (selectedState) {
        content = (
            <StateProperties
                state={selectedState}
                tools={tools}
                isInitial={chart.initial === selectedState.id}
                onChange={patch => props.onStateChange(selectedState.id, patch)}
                onSetInitial={() => props.onChartChange({ initial: selectedState.id })}
                onDelete={() => props.onDeleteNode(selectedState.id)}
            />
        );
    } else if (selectedTransition) {
        content = (
            <TransitionProperties
                transition={selectedTransition}
                tools={tools}
                onChange={patch => props.onTransitionChange(selectedTransition.id, patch)}
                onDelete={() => props.onDeleteTransition(selectedTransition.id)}
            />
        );
    } else if (selectedFunction) {
        content = (
            <FunctionProperties
                fn={selectedFunction}
                tools={tools}
                onChange={patch => props.onFunctionChange(selectedFunction.id, patch)}
                onDelete={() => props.onDeleteNode(selectedFunction.id)}
            />
        );
    } else {
        content = (
            <ChartProperties
                chart={chart}
                onChange={props.onChartChange}
            />
        );
    }
    return <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>{content}</Box>;
}
