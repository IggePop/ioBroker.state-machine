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
    const stateIds = new Set(chart.states.map(s => s.id));
    /** @type {StateFlowNode[]} */
    const states = chart.states.map(state => ({
        id: state.id,
        type: "state",
        // like in React Flow, the position of a child is relative to its parent
        position: { x: state.x, y: state.y },
        width: state.width || DEFAULT_STATE_WIDTH,
        height: state.height || DEFAULT_STATE_HEIGHT,
        ...(state.parent && stateIds.has(state.parent) ? { parentId: state.parent, expandParent: true } : {}),
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
        nodes: sortParentsFirst([...states, ...functions]),
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
            states.push({
                ...node.data.state,
                ...getGeometry(node, DEFAULT_STATE_WIDTH, DEFAULT_STATE_HEIGHT),
                parent: node.parentId || null,
            });
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
 * React Flow requires parents to be before their children in the list of nodes
 *
 * @template {{ id: string; parentId?: string }} T
 * @param {T[]} nodes
 * @returns {T[]}
 */
export function sortParentsFirst(nodes) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    /** @param {T} node */
    const depth = node => {
        let d = 0;
        for (let parent = node.parentId; parent && d <= nodes.length; d++) {
            parent = byId.get(parent)?.parentId;
        }
        return d;
    };
    // the sort is stable, so the order of the states on the same level is kept
    return [...nodes].sort((a, b) => depth(a) - depth(b));
}

/**
 * @param {{ id: string; parentId?: string }[]} nodes
 * @param {string} ancestorId
 * @param {string} id
 * @returns {boolean} true if node "id" is a (direct or indirect) child of node "ancestorId"
 */
export function isDescendantNode(nodes, ancestorId, id) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    let parent = byId.get(id)?.parentId;
    for (let i = 0; parent && i < nodes.length; i++) {
        if (parent === ancestorId) {
            return true;
        }
        parent = byId.get(parent)?.parentId;
    }
    return false;
}

/**
 * @typedef {{ x: number; y: number; width: number; height: number }} Rect
 */

/**
 * Finds the state a node is dropped into: the smallest state which contains the center of the node.
 * The node itself, its children and function blocks are no candidates.
 *
 * @param {ChartFlowNode[]} nodes
 * @param {string} id ID of the dragged node
 * @param {(id: string) => Rect | null} getRect Absolute position and size of a node
 * @returns {string | null} ID of the new parent, null for the top level
 */
export function findDropParent(nodes, id, getRect) {
    const rect = getRect(id);
    if (!rect) {
        return null;
    }
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    let best = null;
    let bestArea = Infinity;
    for (const node of nodes) {
        if (node.type !== "state" || node.id === id || isDescendantNode(nodes, id, node.id)) {
            continue;
        }
        const r = getRect(node.id);
        if (
            r &&
            cx >= r.x &&
            cx <= r.x + r.width &&
            cy >= r.y &&
            cy <= r.y + r.height &&
            r.width * r.height < bestArea
        ) {
            best = node.id;
            bestArea = r.width * r.height;
        }
    }
    return best;
}

/**
 * Moves dragged states into the state they were dropped into, or out of their parent.
 * The positions are converted, so the states stay where they were dropped.
 *
 * @param {ChartFlowNode[]} nodes
 * @param {string[]} draggedIds
 * @param {(id: string) => Rect | null} getRect Absolute position and size of a node (before the change)
 * @returns {ChartFlowNode[]} the same array if nothing changed
 */
export function reparentNodes(nodes, draggedIds, getRect) {
    let result = nodes;
    for (const id of draggedIds) {
        const node = result.find(n => n.id === id);
        // a child dragged together with its parent stays in it
        if (node?.type !== "state" || (node.parentId && draggedIds.includes(node.parentId))) {
            continue;
        }
        const parentId = findDropParent(result, id, getRect);
        const rect = getRect(id);
        if ((node.parentId || null) === parentId || !rect) {
            continue;
        }
        const parentRect = parentId ? getRect(parentId) : null;
        /** @type {StateFlowNode} */
        const moved = {
            ...node,
            position: { x: rect.x - (parentRect?.x ?? 0), y: rect.y - (parentRect?.y ?? 0) },
        };
        if (parentId) {
            moved.parentId = parentId;
            moved.expandParent = true;
        } else {
            delete moved.parentId;
            delete moved.expandParent;
        }
        result = result.map(n => (n.id === id ? moved : n));
    }
    return result === nodes ? nodes : sortParentsFirst(result);
}

/**
 * The initial state of every level: the configured one if it is valid, otherwise the first state,
 * exactly like the runtime does it
 *
 * @param {ChartFlowNode[]} nodes
 * @param {string | undefined} chartInitial Initial state of the top level
 * @returns {Set<string>} IDs of all initial states
 */
export function getInitialStateIds(nodes, chartInitial) {
    /** @type {Map<string, string[]>} children by parent ID, "" for the top level */
    const children = new Map();
    /** @type {Map<string, string | undefined>} configured initial state by parent ID */
    const configured = new Map([["", chartInitial]]);
    for (const node of nodes) {
        if (node.type !== "state") {
            continue;
        }
        const parent = node.parentId || "";
        children.set(parent, [...(children.get(parent) || []), node.id]);
        configured.set(node.id, node.data.state.initial);
    }
    const result = new Set();
    for (const [parent, ids] of children) {
        const initial = configured.get(parent);
        result.add(initial && ids.includes(initial) ? initial : ids[0]);
    }
    return result;
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
