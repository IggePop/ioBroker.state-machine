"use strict";

/*
 * The chart model shared by the editor (admin tab) and the runtime (adapter).
 *
 * A chart is stored as object "state-machine.<instance>.charts.<chartId>" (type "channel"),
 * the model itself lives in `native.chart` of that object.
 */

/** Current version of the chart model, increase on incompatible changes */
const CHART_MODEL_VERSION = 1;

/**
 * @typedef {"input" | "output" | "local"} SymbolScope
 */

/**
 * A variable which can be used in conditions and actions.
 * Inputs and outputs are mapped to ioBroker states, locals only live inside the chart.
 *
 * @typedef {object} ChartSymbol
 * @property {string} name Name used in conditions and actions, must be a valid JavaScript identifier
 * @property {SymbolScope} scope Input (read from state), output (written to state) or local
 * @property {string} [stateId] ioBroker state ID for inputs and outputs
 * @property {any} [initial] Initial value for locals
 */

/**
 * @typedef {object} ChartState
 * @property {string} id Unique and stable ID inside the chart
 * @property {string} name Display name, also used for the "activeState" state
 * @property {string | null} [parent] ID of the parent state, null/undefined for top level states
 * @property {string} [initial] ID of the initial child state (only for states with children)
 * @property {string} [entry] Action executed when the state is entered
 * @property {string} [during] Action executed on every wakeup while the state is active and no transition is taken
 * @property {string} [exit] Action executed when the state is left
 * @property {number} x Position in the editor, relative to the parent state
 * @property {number} y Position in the editor, relative to the parent state
 * @property {number} [width] Size in the editor
 * @property {number} [height] Size in the editor
 */

/**
 * @typedef {object} ChartTransition
 * @property {string} id Unique and stable ID inside the chart
 * @property {string} source ID of the source state
 * @property {string} target ID of the target state
 * @property {string} [label] Transition label in Stateflow syntax: event[condition]{action}
 * @property {number} [priority] Evaluation order of transitions with the same source, lower is first
 * @property {boolean} [reenterParent] Only for transitions from a state to one of its own children: leave and
 *     enter the source state again. Default is an inner transition, which keeps the source state active.
 * @property {string} [sourceHandle] Side of the source state where the arrow starts (editor only)
 * @property {string} [targetHandle] Side of the target state where the arrow ends (editor only)
 */

/**
 * A block with JavaScript code, executed once when the chart starts.
 * The functions declared in it can be used in all conditions and actions of the chart.
 *
 * @typedef {object} ChartFunction
 * @property {string} id Unique and stable ID inside the chart
 * @property {string} code JavaScript, usually one or more function declarations
 * @property {number} x Position in the editor
 * @property {number} y Position in the editor
 * @property {number} [width] Size in the editor
 * @property {number} [height] Size in the editor
 */

/**
 * @typedef {object} Chart
 * @property {number} version Model version, see CHART_MODEL_VERSION
 * @property {string} name Display name
 * @property {boolean} enabled If the chart is executed by the adapter
 * @property {boolean} [restoreState] Continue with the state from before a restart of the adapter, default true
 * @property {string} [initial] ID of the initial top level state (default transition)
 * @property {ChartSymbol[]} symbols
 * @property {ChartState[]} states
 * @property {ChartTransition[]} transitions
 * @property {ChartFunction[]} [functions] Missing in charts created before function blocks existed
 */

/**
 * @typedef {object} TransitionLabel
 * @property {string} [event] Name of the triggering event (an input symbol), undefined = any wakeup
 * @property {number} [afterMs] Delay of a temporal transition after(n, unit) in milliseconds
 * @property {string} [condition] Guard expression
 * @property {string} [action] Transition action
 */

const TIME_UNITS = {
    msec: 1,
    sec: 1000,
    min: 60_000,
};

/**
 * Creates a new, empty chart
 *
 * @param {string} name Display name
 * @returns {Chart}
 */
function createChart(name) {
    return {
        version: CHART_MODEL_VERSION,
        name,
        enabled: true,
        symbols: [],
        states: [],
        transitions: [],
        functions: [],
    };
}

/**
 * Converts a display name to an ID which can be used in ioBroker object IDs
 *
 * @param {string} name
 * @returns {string}
 */
function nameToId(name) {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/ä/g, "ae")
            .replace(/ö/g, "oe")
            .replace(/ü/g, "ue")
            .replace(/ß/g, "ss")
            .replace(/[^a-z0-9_-]+/g, "_")
            .replace(/^_+|_+$/g, "") || "chart"
    );
}

/**
 * @typedef {object} TextRange
 * @property {number} from Index of the first character
 * @property {number} to Index after the last character
 */

/**
 * @typedef {object} TransitionLabelRanges Positions of the parts in the label text
 * @property {TextRange} [event]
 * @property {TextRange} [after] The whole after(...) expression
 * @property {TextRange} [condition] Content of [...] without the brackets
 * @property {TextRange} [action] Content of {...} without the brackets
 */

/**
 * Fills the %s placeholders of a message
 *
 * @param {string} key Message with %s placeholders
 * @param {string[]} args
 * @returns {string}
 */
function formatMessage(key, args) {
    let i = 0;
    return key.replace(/%s/g, () => args[i++] ?? "");
}

/**
 * Error in the structure of a transition label, knows where in the label the problem is
 */
class LabelSyntaxError extends Error {
    /**
     * @param {string} key Message with %s placeholders, used to translate the message
     * @param {string[]} args
     * @param {number} from
     * @param {number} to
     */
    constructor(key, args, from, to) {
        super(formatMessage(key, args));
        this.key = key;
        this.args = args;
        this.from = from;
        this.to = to;
    }
}

/**
 * Reads a part enclosed in brackets, nested brackets of the same type are allowed
 *
 * @param {string} text
 * @param {number} start Index of the opening bracket
 * @param {string} open
 * @param {string} close
 * @returns {{ content: string; from: number; end: number }} from is the index of the (trimmed) content,
 *     end is the index after the closing bracket
 */
function readEnclosed(text, start, open, close) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === open) {
            depth++;
        } else if (text[i] === close) {
            depth--;
            if (depth === 0) {
                const raw = text.substring(start + 1, i);
                const content = raw.trim();
                return { content, from: start + 1 + raw.indexOf(content), end: i + 1 };
            }
        }
    }
    throw new LabelSyntaxError('Missing "%s"', [close], start, text.length);
}

/**
 * Parses a transition label and returns where its parts are, see parseTransitionLabel
 *
 * @param {string | undefined} label
 * @returns {{ label: TransitionLabel; ranges: TransitionLabelRanges }}
 * @throws {LabelSyntaxError}
 */
function parseTransitionLabelWithRanges(label) {
    /** @type {TransitionLabel} */
    const result = {};
    /** @type {TransitionLabelRanges} */
    const ranges = {};
    const text = label || "";
    let pos = 0;

    const skipSpace = () => {
        while (pos < text.length && /\s/.test(text[pos])) {
            pos++;
        }
    };

    skipSpace();
    const eventMatch = /[A-Za-z_$][\w$]*/y;
    eventMatch.lastIndex = pos;
    const event = eventMatch.exec(text);
    if (event) {
        const from = pos;
        pos += event[0].length;
        skipSpace();
        if (event[0] === "after" && text[pos] === "(") {
            const { content, end } = readEnclosed(text, pos, "(", ")");
            const afterMatch = /^(\d+(?:\.\d+)?)\s*,\s*(msec|sec|min)$/.exec(content);
            if (!afterMatch) {
                throw new LabelSyntaxError(
                    'Invalid temporal expression "%s", expected e.g. after(5, sec)',
                    [`after(${content})`],
                    from,
                    end,
                );
            }
            result.afterMs = parseFloat(afterMatch[1]) * TIME_UNITS[afterMatch[2]];
            ranges.after = { from, to: end };
            pos = end;
        } else {
            result.event = event[0];
            ranges.event = { from, to: from + event[0].length };
        }
    }

    skipSpace();
    if (text[pos] === "[") {
        const { content, from, end } = readEnclosed(text, pos, "[", "]");
        result.condition = content;
        ranges.condition = { from, to: from + content.length };
        pos = end;
    }

    skipSpace();
    if (text[pos] === "{") {
        const { content, from, end } = readEnclosed(text, pos, "{", "}");
        result.action = content;
        ranges.action = { from, to: from + content.length };
        pos = end;
    }

    skipSpace();
    if (pos < text.length) {
        throw new LabelSyntaxError(
            'Unexpected "%s", expected event[condition]{action}',
            [text.substring(pos).trim()],
            pos,
            text.length,
        );
    }
    return { label: result, ranges };
}

/**
 * Parses a transition label in Stateflow syntax: event[condition]{action}
 * All parts are optional. Instead of an event, after(n, sec|msec|min) creates a temporal transition.
 *
 * @param {string | undefined} label
 * @returns {TransitionLabel}
 * @throws {LabelSyntaxError}
 */
function parseTransitionLabel(label) {
    return parseTransitionLabelWithRanges(label).label;
}

/** Identifies files with exported charts */
const EXPORT_FORMAT = "iobroker.state-machine";

/**
 * The content of an export file
 *
 * @param {Chart[]} charts
 * @returns {{ format: string; version: number; exported: string; charts: Chart[] }}
 */
function createExport(charts) {
    return { format: EXPORT_FORMAT, version: CHART_MODEL_VERSION, exported: new Date().toISOString(), charts };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SCOPES = ["input", "output", "local"];

/**
 * @param {any} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a chart of an export file and fills in defaults for missing optional values
 *
 * @param {any} data
 * @param {string} where Prefix of error messages, e.g. "Chart 1"
 * @returns {Chart}
 * @throws {Error} if the chart is invalid
 */
function normalizeChart(data, where) {
    /** @param {string} message */
    const fail = message => {
        throw new Error(`${where}: ${message}`);
    };
    if (!isObject(data)) {
        fail("not an object");
    }
    if (typeof data.version === "number" && data.version > CHART_MODEL_VERSION) {
        fail(`created with a newer version of the adapter (chart version ${data.version})`);
    }
    for (const list of ["states", "transitions", "symbols"]) {
        if (!Array.isArray(data[list])) {
            fail(`"${list}" is missing or no list`);
        }
    }
    if (data.functions !== undefined && !Array.isArray(data.functions)) {
        fail('"functions" is no list');
    }
    /** @type {any[]} */
    const functions = data.functions || [];

    // states and function blocks are both nodes in the editor, so their IDs must be unique together
    const nodeIds = new Set();
    /**
     * @param {any} item
     * @param {string} kind
     * @param {number} index
     * @returns {string} the ID
     */
    const checkId = (item, kind, index) => {
        if (!isObject(item) || typeof item.id !== "string" || !item.id) {
            fail(`${kind} ${index + 1} has no ID`);
        }
        if (nodeIds.has(item.id)) {
            fail(`${kind} ${item.id}: the ID is used more than once`);
        }
        nodeIds.add(item.id);
        return item.id;
    };
    /**
     * @param {any} value
     * @param {string} message
     */
    const optionalString = (value, message) => {
        if (value !== undefined && value !== null && typeof value !== "string") {
            fail(message);
        }
    };

    data.states.forEach((/** @type {any} */ state, /** @type {number} */ i) => checkId(state, "state", i));
    functions.forEach((/** @type {any} */ fn, /** @type {number} */ i) => checkId(fn, "function block", i));
    const stateIds = new Set(data.states.map((/** @type {any} */ s) => s.id));

    /** @type {ChartState[]} */
    const states = data.states.map((/** @type {any} */ state) => {
        const at = `state ${state.id}`;
        if (state.parent && !stateIds.has(state.parent)) {
            fail(`${at}: unknown parent state "${state.parent}"`);
        }
        for (const field of ["entry", "during", "exit", "initial"]) {
            optionalString(state[field], `${at}: "${field}" is no text`);
        }
        return {
            ...state,
            name: typeof state.name === "string" && state.name ? state.name : state.id,
            parent: state.parent || null,
            x: Number.isFinite(state.x) ? state.x : 0,
            y: Number.isFinite(state.y) ? state.y : 0,
        };
    });

    // a parent must not be its own (indirect) child
    const parentOf = new Map(states.map(s => [s.id, s.parent]));
    for (const state of states) {
        let parent = state.parent;
        for (let i = 0; parent; i++) {
            if (parent === state.id || i > states.length) {
                fail(`state ${state.id}: the parent states form a cycle`);
            }
            parent = parentOf.get(parent) ?? null;
        }
    }

    const transitionIds = new Set();
    /** @type {ChartTransition[]} */
    const transitions = data.transitions.map((/** @type {any} */ transition, /** @type {number} */ i) => {
        if (!isObject(transition) || typeof transition.id !== "string" || !transition.id) {
            fail(`transition ${i + 1} has no ID`);
        }
        const at = `transition ${transition.id}`;
        if (transitionIds.has(transition.id)) {
            fail(`${at}: the ID is used more than once`);
        }
        transitionIds.add(transition.id);
        for (const end of ["source", "target"]) {
            if (!stateIds.has(transition[end])) {
                fail(`${at}: unknown ${end} state "${transition[end]}"`);
            }
        }
        optionalString(transition.label, `${at}: "label" is no text`);
        if (transition.priority !== undefined && !Number.isFinite(transition.priority)) {
            fail(`${at}: "priority" is no number`);
        }
        return { ...transition };
    });

    const symbolNames = new Set();
    /** @type {ChartSymbol[]} */
    const symbols = data.symbols.map((/** @type {any} */ symbol, /** @type {number} */ i) => {
        if (!isObject(symbol) || typeof symbol.name !== "string" || !IDENTIFIER.test(symbol.name)) {
            fail(`variable ${i + 1}: invalid name`);
        }
        if (symbolNames.has(symbol.name)) {
            fail(`variable ${symbol.name}: the name is used more than once`);
        }
        symbolNames.add(symbol.name);
        if (!SCOPES.includes(symbol.scope)) {
            fail(`variable ${symbol.name}: invalid kind "${symbol.scope}"`);
        }
        optionalString(symbol.stateId, `variable ${symbol.name}: "stateId" is no text`);
        return { ...symbol };
    });

    /** @type {ChartFunction[]} */
    const normalizedFunctions = functions.map(fn => {
        if (typeof fn.code !== "string") {
            fail(`function block ${fn.id}: "code" is no text`);
        }
        return { ...fn, x: Number.isFinite(fn.x) ? fn.x : 0, y: Number.isFinite(fn.y) ? fn.y : 0 };
    });

    return {
        ...data,
        version: CHART_MODEL_VERSION,
        name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : where,
        initial: typeof data.initial === "string" && stateIds.has(data.initial) ? data.initial : undefined,
        enabled: data.enabled !== false,
        symbols,
        states,
        transitions,
        functions: normalizedFunctions,
    };
}

/**
 * Reads the charts of an export file. A single chart (without the export wrapper) is accepted as well.
 *
 * @param {string} text Content of the file
 * @returns {Chart[]}
 * @throws {Error} if the file is invalid
 */
function parseExport(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new Error(`No valid JSON: ${err.message}`);
    }
    if (isObject(data) && data.format === EXPORT_FORMAT) {
        if (typeof data.version === "number" && data.version > CHART_MODEL_VERSION) {
            throw new Error(`The file was created with a newer version of the adapter (version ${data.version})`);
        }
        if (!Array.isArray(data.charts) || !data.charts.length) {
            throw new Error("The file contains no charts");
        }
        return data.charts.map((/** @type {any} */ chart, /** @type {number} */ i) =>
            normalizeChart(chart, `Chart ${i + 1}`),
        );
    }
    if (isObject(data) && Array.isArray(data.states)) {
        return [normalizeChart(data, "Chart")];
    }
    throw new Error("The file contains no charts of the state-machine adapter");
}

module.exports = {
    CHART_MODEL_VERSION,
    EXPORT_FORMAT,
    LabelSyntaxError,
    createChart,
    createExport,
    formatMessage,
    nameToId,
    parseExport,
    parseTransitionLabel,
    parseTransitionLabelWithRanges,
};
