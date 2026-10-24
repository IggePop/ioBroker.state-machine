import React, { useMemo } from "react";
import { Box, Button, Checkbox, FormControlLabel, TextField, Typography } from "@mui/material";
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
 * @param {boolean} props.toChild If the target is a child of the source
 * @param {CodeTools} props.tools
 * @param {(patch: Partial<ChartTransition>) => void} props.onChange
 * @param {() => void} props.onDelete
 */
function TransitionProperties({ transition, toChild, tools, onChange, onDelete }) {
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
            {toChild && (
                <Box>
                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={!!transition.reenterParent}
                                onChange={e => onChange({ reenterParent: e.target.checked || undefined })}
                            />
                        }
                        label={I18n.t("Leave and enter the parent state again")}
                    />
                    <Typography
                        variant="caption"
                        component="div"
                        color="text.secondary"
                    >
                        {I18n.t(transition.reenterParent ? "outerToChildHelp" : "innerTransitionHelp")}
                    </Typography>
                </Box>
            )}
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
            {/* running or paused is changed with the button in the chart list */}
            <Box>
                <FormControlLabel
                    control={
                        <Checkbox
                            checked={chart.restoreState !== false}
                            onChange={e => onChange({ restoreState: e.target.checked })}
                        />
                    }
                    label={I18n.t("Restore the state after a restart")}
                />
                <Typography
                    variant="caption"
                    component="div"
                    color="text.secondary"
                >
                    {I18n.t("restoreStateHelp")}
                </Typography>
            </Box>
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
 * @param {boolean} props.isInitial If the selected state is the initial state of its level
 * @param {boolean} props.toChild If the target of the selected transition is a child of its source
 * @param {(id: string) => void} props.onSetInitial Makes a state the initial state of its level
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
                isInitial={props.isInitial}
                onChange={patch => props.onStateChange(selectedState.id, patch)}
                onSetInitial={() => props.onSetInitial(selectedState.id)}
                onDelete={() => props.onDeleteNode(selectedState.id)}
            />
        );
    } else if (selectedTransition) {
        content = (
            <TransitionProperties
                transition={selectedTransition}
                toChild={props.toChild}
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
