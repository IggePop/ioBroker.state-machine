import React, { useCallback, useMemo, useState } from "react";
import {
    applyEdgeChanges,
    applyNodeChanges,
    Background,
    ConnectionMode,
    Controls,
    MarkerType,
    MiniMap,
    ReactFlow,
    ReactFlowProvider,
    useReactFlow,
} from "@xyflow/react";
import { Box, Button, Tab, Tabs, Toolbar } from "@mui/material";
import { Add as AddIcon, Functions as FunctionIcon, Save as SaveIcon } from "@mui/icons-material";
import { I18n } from "@iobroker/adapter-react-v5";

import StateNode from "./StateNode";
import FunctionNode from "./FunctionNode";
import TransitionEdge from "./TransitionEdge";
import PropertiesPanel from "./PropertiesPanel";
import ResizablePanel from "./ResizablePanel";
import SymbolsEditor from "./SymbolsEditor";
import { translateDiagnostic } from "./CodeEditor";
import {
    chartToFlow,
    createId,
    DEFAULT_FUNCTION_HEIGHT,
    DEFAULT_FUNCTION_WIDTH,
    DEFAULT_STATE_HEIGHT,
    DEFAULT_STATE_WIDTH,
    flowToChart,
} from "../flow-model";
import { getDeclarations, validateChart } from "../../../lib/chart-validation";

/**
 * @typedef {import("../../../lib/chart-model").Chart} Chart
 * @typedef {import("../flow-model").ChartFlowNode} ChartFlowNode
 * @typedef {import("../flow-model").TransitionFlowEdge} TransitionFlowEdge
 */

// defined outside the component, so React Flow does not re-create them on every render
const nodeTypes = { state: StateNode, function: FunctionNode };
const edgeTypes = { transition: TransitionEdge };
const markerEnd = { type: MarkerType.ArrowClosed, width: 18, height: 18 };

/**
 * @typedef {object} ChartEditorProps
 * @property {Chart} chart The saved chart
 * @property {string[]} activeIds IDs of the currently active states
 * @property {(chart: Chart) => Promise<void>} onSave
 * @property {any} socket
 * @property {import("@iobroker/adapter-react-v5").IobTheme} theme
 */

/**
 * @param {ChartEditorProps} props
 */
function ChartEditorInner({ chart: savedChart, activeIds, onSave, socket, theme }) {
    const reactFlow = useReactFlow();
    /** chart level properties (name, symbols, initial state, ...), states and transitions live in nodes/edges */
    const [chart, setChart] = useState(savedChart);
    const [nodes, setNodes] = useState(() => chartToFlow(savedChart).nodes);
    const [edges, setEdges] = useState(() => chartToFlow(savedChart).edges);
    const [changed, setChanged] = useState(false);
    const [saving, setSaving] = useState(false);
    const [panelTab, setPanelTab] = useState("properties");

    /** @type {import("@xyflow/react").OnNodesChange<ChartFlowNode>} */
    const onNodesChange = useCallback(changes => {
        setNodes(nds => applyNodeChanges(changes, nds));
        // selection and measuring are no modifications of the chart
        if (
            changes.some(c => c.type === "position" || c.type === "remove" || (c.type === "dimensions" && c.resizing))
        ) {
            setChanged(true);
        }
    }, []);

    /** @type {import("@xyflow/react").OnEdgesChange<TransitionFlowEdge>} */
    const onEdgesChange = useCallback(changes => {
        setEdges(eds => applyEdgeChanges(changes, eds));
        if (changes.some(c => c.type === "remove")) {
            setChanged(true);
        }
    }, []);

    /** @type {import("@xyflow/react").OnConnect} */
    const onConnect = useCallback(connection => {
        setEdges(eds => {
            const id = createId("t", eds);
            const outgoing = eds.filter(e => e.source === connection.source).length;
            return [
                ...eds.map(e => ({ ...e, selected: false })),
                {
                    id,
                    type: "transition",
                    source: connection.source,
                    target: connection.target,
                    sourceHandle: connection.sourceHandle,
                    targetHandle: connection.targetHandle,
                    selected: true,
                    data: {
                        transition: {
                            id,
                            source: connection.source,
                            target: connection.target,
                            label: "",
                            priority: outgoing + 1,
                        },
                    },
                },
            ];
        });
        setNodes(nds => nds.map(n => ({ ...n, selected: false })));
        setChanged(true);
    }, []);

    // a double click selects the state/transition (first click) and shows its properties
    const showProperties = useCallback(() => setPanelTab("properties"), []);

    /**
     * Adds a node in the middle of the visible area and selects it
     *
     * @param {(id: string, x: number, y: number) => ChartFlowNode} create
     * @param {string} idPrefix
     * @returns {string} ID of the new node
     */
    const addNode = (create, idPrefix) => {
        const id = createId(idPrefix, nodes);
        const { x, y } = reactFlow.screenToFlowPosition({ x: window.innerWidth / 3, y: window.innerHeight / 3 });
        setNodes(nds => [
            ...nds.map(n => ({ ...n, selected: false })),
            { ...create(id, Math.round(x), Math.round(y)), selected: true },
        ]);
        setEdges(eds => eds.map(e => ({ ...e, selected: false })));
        setPanelTab("properties");
        setChanged(true);
        return id;
    };

    const addState = () => {
        const states = nodes.filter(n => n.type === "state");
        const id = addNode(
            (id, x, y) => ({
                id,
                type: "state",
                position: { x, y },
                width: DEFAULT_STATE_WIDTH,
                height: DEFAULT_STATE_HEIGHT,
                data: { state: { id, name: `${I18n.t("State")} ${states.length + 1}`, x, y } },
            }),
            "s",
        );
        if (!states.some(n => n.id === chart.initial)) {
            setChart(c => ({ ...c, initial: id }));
        }
    };

    const addFunction = () => {
        addNode(
            (id, x, y) => ({
                id,
                type: "function",
                position: { x, y },
                width: DEFAULT_FUNCTION_WIDTH,
                height: DEFAULT_FUNCTION_HEIGHT,
                data: { fn: { id, code: "function myFunction(value) {\n    return value;\n}", x, y } },
            }),
            "f",
        );
    };

    /**
     * @param {Partial<Chart>} patch
     */
    const updateChart = patch => {
        setChart(c => ({ ...c, ...patch }));
        setChanged(true);
    };

    /**
     * @param {string} id
     * @param {Partial<import("../../../lib/chart-model").ChartState>} patch
     */
    const updateState = (id, patch) => {
        setNodes(nds =>
            nds.map(n =>
                n.id === id && n.type === "state" ? { ...n, data: { state: { ...n.data.state, ...patch } } } : n,
            ),
        );
        setChanged(true);
    };

    /**
     * @param {string} id
     * @param {Partial<import("../../../lib/chart-model").ChartFunction>} patch
     */
    const updateFunction = (id, patch) => {
        setNodes(nds =>
            nds.map(n =>
                n.id === id && n.type === "function" ? { ...n, data: { fn: { ...n.data.fn, ...patch } } } : n,
            ),
        );
        setChanged(true);
    };

    /**
     * @param {string} id
     * @param {Partial<import("../../../lib/chart-model").ChartTransition>} patch
     */
    const updateTransition = (id, patch) => {
        setEdges(eds =>
            eds.map(e =>
                e.id === id
                    ? {
                          ...e,
                          data: {
                              ...e.data,
                              transition: { ...e.data?.transition, ...patch, id, source: e.source, target: e.target },
                          },
                      }
                    : e,
            ),
        );
        setChanged(true);
    };

    const save = async () => {
        const newChart = flowToChart(chart, nodes, edges);
        if (!newChart.states.some(s => s.id === newChart.initial)) {
            newChart.initial = newChart.states[0]?.id;
        }
        setSaving(true);
        try {
            await onSave(newChart);
            setChart(newChart);
            setChanged(false);
        } finally {
            setSaving(false);
        }
    };

    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    const selectedNode = selectedNodes.length === 1 && !selectedEdges.length ? selectedNodes[0] : null;
    const selectedState = selectedNode?.type === "state" ? selectedNode.data.state : null;
    const selectedFunction = selectedNode?.type === "function" ? selectedNode.data.fn : null;
    const selectedTransition =
        selectedEdges.length === 1 && !selectedNodes.length ? selectedEdges[0].data?.transition || null : null;

    // add the information which is not stored in the nodes/edges themselves
    // only the code and the variables matter for the validation, not e.g. the positions which change while dragging
    const codeSignature = JSON.stringify([
        chart.symbols,
        nodes.map(n =>
            n.type === "function"
                ? [n.id, n.data.fn.code]
                : [n.id, n.data.state.entry, n.data.state.during, n.data.state.exit],
        ),
        edges.map(e => [e.id, e.data?.transition.label]),
    ]);
    const functionCodes = JSON.stringify(nodes.map(n => (n.type === "function" ? n.data.fn.code : null)));
    const { functions, declarations } = useMemo(() => {
        const fns = nodes.flatMap(n => (n.type === "function" ? [n.data.fn] : []));
        return {
            functions: fns,
            /** names declared in the function blocks, they can be used in all conditions and actions */
            declarations: fns.flatMap(fn => getDeclarations(fn.code)),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [functionCodes]);

    /** translated problem messages by state/transition/function ID */
    const problems = useMemo(() => {
        /** @type {Map<string, string[]>} */
        const byId = new Map();
        for (const problem of validateChart(flowToChart(chart, nodes, edges))) {
            const prefix = problem.kind === "state" ? `${problem.field}: ` : "";
            byId.set(problem.id, [...(byId.get(problem.id) || []), prefix + translateDiagnostic(problem.diagnostic)]);
        }
        return byId;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codeSignature]);

    const displayNodes = useMemo(
        () =>
            nodes.map(n => ({
                ...n,
                // the extra fields are only read by the node components
                data: /** @type {any} */ ({
                    ...n.data,
                    isInitial: n.id === chart.initial,
                    isActive: activeIds.includes(n.id),
                    problems: problems.get(n.id),
                }),
            })),
        [nodes, chart.initial, activeIds, problems],
    );
    const displayEdges = useMemo(() => {
        /** @type {Record<string, number>} */
        const outgoing = {};
        edges.forEach(e => (outgoing[e.source] = (outgoing[e.source] || 0) + 1));
        return edges.map(
            e =>
                /** @type {TransitionFlowEdge} */ ({
                    ...e,
                    // like the nodes: no zooming on double click and no panning when dragging the edge
                    className: "nopan",
                    markerEnd,
                    data: { ...e.data, showPriority: outgoing[e.source] > 1, problems: problems.get(e.id) },
                }),
        );
    }, [edges, problems]);

    return (
        <Box sx={{ display: "flex", height: "100%", minHeight: 0 }}>
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
                <Toolbar
                    variant="dense"
                    sx={{ gap: 1, borderBottom: 1, borderColor: "divider" }}
                >
                    <Button
                        startIcon={<AddIcon />}
                        onClick={addState}
                    >
                        {I18n.t("Add state")}
                    </Button>
                    <Button
                        startIcon={<FunctionIcon />}
                        onClick={addFunction}
                    >
                        {I18n.t("Add function")}
                    </Button>
                    <Box sx={{ flex: 1 }} />
                    <Button
                        variant="contained"
                        startIcon={<SaveIcon />}
                        disabled={!changed || saving}
                        onClick={save}
                    >
                        {I18n.t("Save")}
                    </Button>
                </Toolbar>
                <Box sx={{ flex: 1, minHeight: 0 }}>
                    <ReactFlow
                        nodes={displayNodes}
                        edges={displayEdges}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onNodeDoubleClick={showProperties}
                        onEdgeDoubleClick={showProperties}
                        connectionMode={ConnectionMode.Loose}
                        colorMode={theme.palette.mode}
                        snapToGrid
                        snapGrid={[10, 10]}
                        deleteKeyCode={["Delete", "Backspace"]}
                        fitView
                        fitViewOptions={{ maxZoom: 1 }}
                    >
                        <Background />
                        <Controls />
                        <MiniMap
                            pannable
                            zoomable
                        />
                    </ReactFlow>
                </Box>
            </Box>
            <ResizablePanel
                side="right"
                storageKey="state-machine.propertiesWidth"
                defaultWidth={360}
                minWidth={260}
                maxWidth={900}
            >
                <Tabs
                    value={panelTab}
                    onChange={(_e, value) => setPanelTab(value)}
                    variant="fullWidth"
                >
                    <Tab
                        value="properties"
                        label={I18n.t("Properties")}
                    />
                    <Tab
                        value="symbols"
                        label={I18n.t("Variables")}
                    />
                </Tabs>
                <Box sx={{ p: 2, overflow: "auto", flex: 1 }}>
                    {panelTab === "properties" ? (
                        <PropertiesPanel
                            chart={chart}
                            selectedState={selectedState}
                            selectedTransition={selectedTransition}
                            selectedFunction={selectedFunction}
                            functions={functions}
                            declarations={declarations}
                            onChartChange={updateChart}
                            onStateChange={updateState}
                            onTransitionChange={updateTransition}
                            onFunctionChange={updateFunction}
                            onDeleteNode={id => reactFlow.deleteElements({ nodes: [{ id }] })}
                            onDeleteTransition={id => reactFlow.deleteElements({ edges: [{ id }] })}
                        />
                    ) : (
                        <SymbolsEditor
                            symbols={chart.symbols}
                            onChange={symbols => updateChart({ symbols })}
                            socket={socket}
                            theme={theme}
                        />
                    )}
                </Box>
            </ResizablePanel>
        </Box>
    );
}

/**
 * Graphical editor for one chart
 *
 * @param {ChartEditorProps} props
 */
export default function ChartEditor(props) {
    return (
        <ReactFlowProvider>
            <ChartEditorInner {...props} />
        </ReactFlowProvider>
    );
}
