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
 * @property {number} x Position in the editor
 * @property {number} y Position in the editor
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

module.exports = {
    CHART_MODEL_VERSION,
    LabelSyntaxError,
    createChart,
    formatMessage,
    nameToId,
    parseTransitionLabel,
    parseTransitionLabelWithRanges,
};
