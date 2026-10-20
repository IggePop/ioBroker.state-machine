/*
 * Conversion between the chart model (lib/chart-model.js) and the nodes/edges of React Flow
 */

/**
 * @typedef {import("../../lib/chart-model").Chart} Chart
 * @typedef {import("../../lib/chart-model").ChartState} ChartState
 * @typedef {import("../../lib/chart-model").ChartTransition} ChartTransition
 * @typedef {import("../../lib/chart-model").ChartFunction} ChartFunction
 * @typedef {import("@xyflow/react").Node<{ state: ChartState }, "state">} StateFlowNode
 * @typedef {import("@xyflow/react").Node<{ fn: ChartFunction }, "function">} FunctionFlowNode
 * @typedef {StateFlowNode | FunctionFlowNode} ChartFlowNode
 * @typedef {import("@xyflow/react").Edge<{ transition: ChartTransition }>} TransitionFlowEdge
 */

export const DEFAULT_STATE_WIDTH = 180;
export const DEFAULT_STATE_HEIGHT = 90;
export const DEFAULT_FUNCTION_WIDTH = 260;
export const DEFAULT_FUNCTION_HEIGHT = 120;

/**
 * @param {Chart} chart
 * @returns {{ nodes: ChartFlowNode[]; edges: TransitionFlowEdge[] }}
 */
export function chartToFlow(chart) {
    /** @type {StateFlowNode[]} */
    const states = chart.states.map(state => ({
        id: state.id,
        type: "state",
        position: { x: state.x, y: state.y },
        width: state.width || DEFAULT_STATE_WIDTH,
        height: state.height || DEFAULT_STATE_HEIGHT,
        data: { state },
    }));
    /** @type {FunctionFlowNode[]} */
    const functions = (chart.functions || []).map(fn => ({
        id: fn.id,
        type: "function",
        position: { x: fn.x, y: fn.y },
        width: fn.width || DEFAULT_FUNCTION_WIDTH,
        height: fn.height || DEFAULT_FUNCTION_HEIGHT,
        data: { fn },
    }));
    return {
        nodes: [...states, ...functions],
        edges: chart.transitions.map(transition => ({
            id: transition.id,
            type: "transition",
            source: transition.source,
            target: transition.target,
            sourceHandle: transition.sourceHandle,
            targetHandle: transition.targetHandle,
            data: { transition },
        })),
    };
}

/**
 * @param {ChartFlowNode} node
 * @param {number} defaultWidth
 * @param {number} defaultHeight
 */
function getGeometry(node, defaultWidth, defaultHeight) {
    return {
        id: node.id,
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
        width: Math.round(node.width ?? node.measured?.width ?? defaultWidth),
        height: Math.round(node.height ?? node.measured?.height ?? defaultHeight),
    };
}

/**
 * Writes positions, sizes and connections from React Flow back into the chart
 *
 * @param {Chart} chart Chart with the chart level properties (name, symbols, ...)
 * @param {ChartFlowNode[]} nodes
 * @param {TransitionFlowEdge[]} edges
 * @returns {Chart}
 */
export function flowToChart(chart, nodes, edges) {
    /** @type {ChartState[]} */
    const states = [];
    /** @type {ChartFunction[]} */
    const functions = [];
    for (const node of nodes) {
        if (node.type === "function") {
            functions.push({
                ...node.data.fn,
                ...getGeometry(node, DEFAULT_FUNCTION_WIDTH, DEFAULT_FUNCTION_HEIGHT),
            });
        } else {
            states.push({ ...node.data.state, ...getGeometry(node, DEFAULT_STATE_WIDTH, DEFAULT_STATE_HEIGHT) });
        }
    }
    return {
        ...chart,
        states,
        functions,
        transitions: edges.map(edge => ({
            ...edge.data?.transition,
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle ?? undefined,
            targetHandle: edge.targetHandle ?? undefined,
        })),
    };
}

/**
 * Creates an ID which is not used yet
 *
 * @param {string} prefix
 * @param {{ id: string }[]} existing
 * @returns {string}
 */
export function createId(prefix, existing) {
    const ids = new Set(existing.map(item => item.id));
    let i = existing.length + 1;
    while (ids.has(`${prefix}${i}`)) {
        i++;
    }
    return `${prefix}${i}`;
}
