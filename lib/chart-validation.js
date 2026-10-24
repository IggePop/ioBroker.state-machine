"use strict";

/*
 * Checks conditions and actions of a chart: JavaScript syntax, unknown variables and events.
 * Used by the editor (to underline errors) and by the runtime (to log them when a chart starts).
 */

const acorn = require("acorn");
const walk = require("acorn-walk");
const { HELPERS } = require("./chart-helpers");
const { LabelSyntaxError, formatMessage, parseTransitionLabelWithRanges } = require("./chart-model");

/**
 * @typedef {import("./chart-model").Chart} Chart
 * @typedef {import("./chart-model").ChartSymbol} ChartSymbol
 */

/** Names which can be used in conditions and actions besides the chart variables */
const GLOBALS = new Set([
    // the helper functions, e.g. log() and setState()
    ...Object.keys(HELPERS),
    "undefined",
    "NaN",
    "Infinity",
    "Math",
    "Date",
    "JSON",
    "Number",
    "String",
    "Boolean",
    "Array",
    "Object",
    "RegExp",
    "Map",
    "Set",
    "Error",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
]);

/** Fields of a state which contain actions */
const STATE_ACTIONS = /** @type {const} */ (["entry", "during", "exit"]);

/**
 * @typedef {object} Diagnostic
 * @property {number} from Position in the checked text
 * @property {number} to
 * @property {"error" | "warning"} severity
 * @property {string} message English message
 * @property {string} key Message with %s placeholders, used to translate it
 * @property {string[]} args
 */

/**
 * @param {number} from
 * @param {number} to
 * @param {"error" | "warning"} severity
 * @param {string} key
 * @param {string[]} [args]
 * @returns {Diagnostic}
 */
function createDiagnostic(from, to, severity, key, args = []) {
    return { from, to, severity, key, args, message: formatMessage(key, args) };
}

/**
 * Parses JavaScript and converts syntax errors to diagnostics
 *
 * @param {string} code
 * @param {"expression" | "statements"} kind
 * @returns {{ ast: acorn.Node } | { diagnostic: Diagnostic }}
 */
function parseCode(code, kind) {
    try {
        if (kind === "statements") {
            return { ast: acorn.parse(code, { ecmaVersion: "latest", sourceType: "script" }) };
        }
        const ast = acorn.parseExpressionAt(code, 0, { ecmaVersion: "latest" });
        const rest = code.substring(ast.end);
        if (rest.trim()) {
            const from = ast.end + rest.length - rest.trimStart().length;
            return { diagnostic: createDiagnostic(from, code.length, "error", 'Unexpected "%s"', [rest.trim()]) };
        }
        return { ast };
    } catch (err) {
        const pos = typeof err.pos === "number" ? Math.min(err.pos, code.length) : 0;
        // acorn adds the position "(line:column)" to its messages, it is shown by the underline anyway
        const message = String(err.message).replace(/\s*\(\d+:\d+\)$/, "");
        // underline the token at the error position, or the last character if the code ends unexpectedly
        const from = pos < code.length ? pos : Math.max(0, code.length - 1);
        const token = /^(\w+|\S)/.exec(code.substring(from));
        const to = Math.min(code.length, from + (token ? token[0].length : 1));
        return { diagnostic: createDiagnostic(from, to, "error", "Syntax error: %s", [message]) };
    }
}

/**
 * Checks a condition or action
 *
 * @param {string | undefined} code
 * @param {"expression" | "statements"} kind Condition (expression) or action (statements)
 * @param {ChartSymbol[]} symbols
 * @param {number} [offset] Position of the code in the text, added to all positions
 * @param {string[]} [functionNames] Names declared in the function blocks of the chart
 * @returns {Diagnostic[]}
 */
function validateCode(code, kind, symbols, offset = 0, functionNames = []) {
    if (!code?.trim()) {
        return [];
    }
    const parsed = parseCode(code, kind);
    if ("diagnostic" in parsed) {
        const d = parsed.diagnostic;
        return [{ ...d, from: d.from + offset, to: d.to + offset }];
    }

    /** names declared in the code itself (let, const, function parameters, ...) */
    const declared = new Set();
    /** @type {{ node: any; write: boolean }[]} */
    const references = [];
    walk.fullAncestor(parsed.ast, (node, _state, ancestors, type) => {
        if (node.type !== "Identifier") {
            return;
        }
        /** @type {any} */
        const parent = ancestors[ancestors.length - 2];
        if (type === "VariablePattern") {
            // acorn-walk uses "VariablePattern" for declarations and for assignment targets
            if (parent?.type === "AssignmentExpression" && parent.left === node) {
                references.push({ node, write: true });
            } else {
                declared.add(node.name);
            }
        } else {
            references.push({ node, write: parent?.type === "UpdateExpression" });
        }
    });

    const inputs = new Set(symbols.filter(s => s.scope === "input").map(s => s.name));
    const known = new Set([...symbols.map(s => s.name), ...functionNames]);
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    for (const { node, write } of references) {
        const from = node.start + offset;
        const to = node.end + offset;
        if (!known.has(node.name) && !declared.has(node.name) && !GLOBALS.has(node.name)) {
            diagnostics.push(createDiagnostic(from, to, "error", 'Unknown variable "%s"', [node.name]));
        } else if (write && inputs.has(node.name) && !declared.has(node.name)) {
            diagnostics.push(
                createDiagnostic(from, to, "warning", 'Input "%s" is overwritten on its next change', [node.name]),
            );
        }
    }
    return diagnostics;
}

/**
 * Checks a transition label: its structure, the event and the JavaScript of condition and action
 *
 * @param {string | undefined} label
 * @param {ChartSymbol[]} symbols
 * @param {string[]} [functionNames] Names declared in the function blocks of the chart
 * @returns {Diagnostic[]}
 */
function validateTransitionLabel(label, symbols, functionNames = []) {
    let parsed;
    try {
        parsed = parseTransitionLabelWithRanges(label);
    } catch (err) {
        if (err instanceof LabelSyntaxError) {
            return [createDiagnostic(err.from, err.to, "error", err.key, err.args)];
        }
        throw err;
    }
    const { label: parts, ranges } = parsed;

    /** @type {Diagnostic[]} */
    const diagnostics = [];
    if (parts.event && ranges.event && !symbols.some(s => s.scope === "input" && s.name === parts.event)) {
        diagnostics.push(
            createDiagnostic(
                ranges.event.from,
                ranges.event.to,
                "error",
                'Unknown event "%s", use the name of an input',
                [parts.event],
            ),
        );
    }
    if (parts.condition && ranges.condition) {
        diagnostics.push(...validateCode(parts.condition, "expression", symbols, ranges.condition.from, functionNames));
    }
    if (parts.action && ranges.action) {
        diagnostics.push(...validateCode(parts.action, "statements", symbols, ranges.action.from, functionNames));
    }
    return diagnostics;
}

/**
 * @typedef {object} Declaration A name declared at the top level of a function block
 * @property {string} name
 * @property {string | null} signature e.g. "clamp(x, lo, hi)", null if it is no function
 * @property {number} from Position of the name in the code
 * @property {number} to
 */

/**
 * Finds the names declared at the top level of a function block: functions, but also constants etc.
 *
 * @param {string | undefined} code
 * @returns {Declaration[]} empty if the code has syntax errors
 */
function getDeclarations(code) {
    if (!code?.trim()) {
        return [];
    }
    const parsed = parseCode(code, "statements");
    if ("diagnostic" in parsed) {
        return [];
    }
    /**
     * @param {any} fn Function node
     * @param {string} name
     */
    const signature = (fn, name) => `${name}(${fn.params.map(p => code.substring(p.start, p.end)).join(", ")})`;

    /** @type {Declaration[]} */
    const declarations = [];
    for (const node of /** @type {any} */ (parsed.ast).body) {
        if (node.type === "FunctionDeclaration" && node.id) {
            const { name, start, end } = node.id;
            declarations.push({ name, signature: signature(node, name), from: start, to: end });
        } else if (node.type === "VariableDeclaration") {
            for (const declarator of node.declarations) {
                if (declarator.id.type !== "Identifier") {
                    continue;
                }
                const { name, start, end } = declarator.id;
                const init = declarator.init;
                const isFunction = init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression";
                declarations.push({ name, signature: isFunction ? signature(init, name) : null, from: start, to: end });
            }
        }
    }
    return declarations;
}

/**
 * Names declared in all function blocks of a chart
 *
 * @param {Chart} chart
 * @returns {string[]}
 */
function getFunctionNames(chart) {
    return (chart.functions || []).flatMap(fn => getDeclarations(fn.code).map(d => d.name));
}

/**
 * @typedef {object} ChartProblem
 * @property {"state" | "transition" | "function"} kind
 * @property {string} id ID of the state, transition or function block
 * @property {string} field "entry", "during", "exit", "label" or "code"
 * @property {Diagnostic} diagnostic
 */

/**
 * Checks all actions, transition labels and function blocks of a chart
 *
 * @param {Chart} chart
 * @returns {ChartProblem[]}
 */
function validateChart(chart) {
    const functionNames = getFunctionNames(chart);
    /** @type {ChartProblem[]} */
    const problems = [];
    for (const state of chart.states) {
        for (const field of STATE_ACTIONS) {
            for (const diagnostic of validateCode(state[field], "statements", chart.symbols, 0, functionNames)) {
                problems.push({ kind: "state", id: state.id, field, diagnostic });
            }
        }
    }
    for (const transition of chart.transitions) {
        for (const diagnostic of validateTransitionLabel(transition.label, chart.symbols, functionNames)) {
            problems.push({ kind: "transition", id: transition.id, field: "label", diagnostic });
        }
    }

    // a name may only be declared once in all function blocks, and not hide a variable
    const symbolNames = new Set(chart.symbols.map(s => s.name));
    const seen = new Set();
    for (const fn of chart.functions || []) {
        for (const diagnostic of validateCode(fn.code, "statements", chart.symbols, 0, functionNames)) {
            problems.push({ kind: "function", id: fn.id, field: "code", diagnostic });
        }
        for (const { name, from, to } of getDeclarations(fn.code)) {
            let key = null;
            if (seen.has(name)) {
                key = '"%s" is declared in more than one function block';
            } else if (symbolNames.has(name) || GLOBALS.has(name)) {
                key = '"%s" is already the name of a variable';
            }
            if (key) {
                problems.push({
                    kind: "function",
                    id: fn.id,
                    field: "code",
                    diagnostic: createDiagnostic(from, to, "error", key, [name]),
                });
            }
            seen.add(name);
        }
    }
    return problems;
}

module.exports = {
    GLOBALS,
    getDeclarations,
    getFunctionNames,
    validateChart,
    validateCode,
    validateTransitionLabel,
};
