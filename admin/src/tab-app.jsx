/* eslint-disable @typescript-eslint/no-require-imports */
import React from "react";
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    List,
    ListItemButton,
    ListItemText,
    StyledEngineProvider,
    TextField,
    ThemeProvider,
    Toolbar,
    Tooltip,
    Typography,
} from "@mui/material";
import { Add as AddIcon, Delete as DeleteIcon } from "@mui/icons-material";
import { DialogConfirm, GenericApp, I18n, Loader } from "@iobroker/adapter-react-v5";
import "@xyflow/react/dist/style.css";

import ChartEditor from "./components/ChartEditor";
import ResizablePanel from "./components/ResizablePanel";
import { createChart, nameToId } from "../../lib/chart-model";

/**
 * @typedef {import("../../lib/chart-model").Chart} Chart
 * @typedef {import("@iobroker/adapter-react-v5").GenericAppState & {
 *     charts: Record<string, ioBroker.Object>;
 *     selectedChart: string | null;
 *     activeIds: string[];
 *     newChartName: string | null;
 *     deleteChart: string | null;
 * }} TabAppState
 */

/**
 * @extends {GenericApp<import("@iobroker/adapter-react-v5").GenericAppProps, TabAppState>}
 */
class TabApp extends GenericApp {
    constructor(props) {
        const extendedProps = {
            ...props,
            encryptedFields: [],
            // the tab is no settings dialog, so it needs no Save/Close buttons
            bottomButtons: false,
            translations: {
                en: require("./i18n/en.json"),
                de: require("./i18n/de.json"),
                ru: require("./i18n/ru.json"),
                pt: require("./i18n/pt.json"),
                nl: require("./i18n/nl.json"),
                fr: require("./i18n/fr.json"),
                it: require("./i18n/it.json"),
                es: require("./i18n/es.json"),
                pl: require("./i18n/pl.json"),
                uk: require("./i18n/uk.json"),
                "zh-cn": require("./i18n/zh-cn.json"),
            },
        };
        super(props, extendedProps);
        this.state = /** @type {TabAppState} */ ({
            ...this.state,
            charts: {},
            selectedChart: null,
            activeIds: [],
            newChartName: null,
            deleteChart: null,
        });
        this.chartPrefix = `${this.adapterName}.${this.instance}.charts.`;
        /** @type {string | null} state with the active state IDs of the selected chart */
        this.activeIdsStateId = null;
    }

    onConnectionReady() {
        // executed when connection is ready: load all charts and keep the list up to date
        this.socket.getObjectViewSystem("channel", this.chartPrefix, `${this.chartPrefix}香`).then(charts => {
            const ids = Object.keys(charts).sort();
            this.setState({ charts });
            if (ids.length) {
                this.selectChart(ids[0]);
            }
        });
        this.socket.subscribeObject(`${this.chartPrefix}*`, this.onObjectChange);
    }

    componentWillUnmount() {
        this.socket.unsubscribeObject(`${this.chartPrefix}*`, this.onObjectChange);
        if (this.activeIdsStateId) {
            this.socket.unsubscribeState(this.activeIdsStateId, this.onActiveIdsChange);
        }
        super.componentWillUnmount();
    }

    /**
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange = (id, obj) => {
        // only the chart objects themselves, not the states below them
        if (id.substring(this.chartPrefix.length).includes(".")) {
            return;
        }
        const charts = { ...this.state.charts };
        if (obj?.type === "channel") {
            charts[id] = obj;
        } else {
            delete charts[id];
        }
        this.setState({ charts });
    };

    /**
     * @param {string} _id
     * @param {ioBroker.State | null | undefined} state
     */
    onActiveIdsChange = (_id, state) => {
        let activeIds = [];
        try {
            activeIds = JSON.parse(String(state?.val || "[]"));
        } catch {
            // ignore invalid values
        }
        this.setState({ activeIds });
    };

    /**
     * @param {string | null} id Object ID of the chart
     */
    selectChart(id) {
        if (this.activeIdsStateId) {
            this.socket.unsubscribeState(this.activeIdsStateId, this.onActiveIdsChange);
            this.activeIdsStateId = null;
        }
        this.setState({ selectedChart: id, activeIds: [] });
        if (id) {
            this.activeIdsStateId = `${id}.activeStateIds`;
            this.socket.subscribeState(this.activeIdsStateId, false, this.onActiveIdsChange);
        }
    }

    /**
     * @param {string} name
     */
    async createChart(name) {
        let id = `${this.chartPrefix}${nameToId(name)}`;
        for (let i = 2; this.state.charts[id]; i++) {
            id = `${this.chartPrefix}${nameToId(name)}_${i}`;
        }
        await this.socket.setObject(id, {
            type: "channel",
            common: { name },
            native: { chart: createChart(name) },
        });
        this.selectChart(id);
    }

    /**
     * @param {string} id Object ID of the chart
     * @param {Chart} chart
     */
    async saveChart(id, chart) {
        try {
            await this.socket.extendObject(id, { common: { name: chart.name }, native: { chart } });
        } catch (err) {
            this.showError(`${I18n.t("Cannot save chart")}: ${err}`);
            throw err;
        }
    }

    /**
     * @param {string} id Object ID of the chart
     */
    async deleteChart(id) {
        // also deletes the states below the chart
        await this.socket.delObjects(id, false);
        if (this.state.selectedChart === id) {
            this.selectChart(Object.keys(this.state.charts).find(chartId => chartId !== id) || null);
        }
    }

    renderChartList() {
        const ids = Object.keys(this.state.charts).sort();
        return (
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                <Toolbar
                    variant="dense"
                    sx={{ gap: 1, borderBottom: 1, borderColor: "divider" }}
                >
                    <Typography
                        variant="subtitle1"
                        sx={{ flex: 1 }}
                    >
                        {I18n.t("Charts")}
                    </Typography>
                    <Tooltip title={I18n.t("New chart")}>
                        <IconButton
                            size="small"
                            onClick={() => this.setState({ newChartName: "" })}
                        >
                            <AddIcon />
                        </IconButton>
                    </Tooltip>
                </Toolbar>
                <List
                    dense
                    sx={{ overflow: "auto", flex: 1 }}
                >
                    {ids.map(id => {
                        const chart = this.state.charts[id].native?.chart;
                        return (
                            <ListItemButton
                                key={id}
                                selected={id === this.state.selectedChart}
                                onClick={() => this.selectChart(id)}
                            >
                                <ListItemText
                                    primary={chart?.name || id.substring(this.chartPrefix.length)}
                                    secondary={chart?.enabled === false ? I18n.t("disabled") : null}
                                />
                                <Tooltip title={I18n.t("Delete chart")}>
                                    <IconButton
                                        size="small"
                                        edge="end"
                                        onClick={e => {
                                            e.stopPropagation();
                                            this.setState({ deleteChart: id });
                                        }}
                                    >
                                        <DeleteIcon fontSize="small" />
                                    </IconButton>
                                </Tooltip>
                            </ListItemButton>
                        );
                    })}
                </List>
            </Box>
        );
    }

    renderNewChartDialog() {
        if (this.state.newChartName === null) {
            return null;
        }
        const name = this.state.newChartName.trim();
        const close = () => this.setState({ newChartName: null });
        const create = () => {
            close();
            this.createChart(name).catch(err => this.showError(String(err)));
        };
        return (
            <Dialog
                open
                onClose={close}
                maxWidth="xs"
                fullWidth
            >
                <DialogTitle>{I18n.t("New chart")}</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        fullWidth
                        variant="standard"
                        label={I18n.t("Name")}
                        value={this.state.newChartName}
                        onChange={e => this.setState({ newChartName: e.target.value })}
                        onKeyDown={e => e.key === "Enter" && name && create()}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={close}>{I18n.t("Cancel")}</Button>
                    <Button
                        variant="contained"
                        disabled={!name}
                        onClick={create}
                    >
                        {I18n.t("Create")}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    renderDeleteDialog() {
        const id = this.state.deleteChart;
        if (!id) {
            return null;
        }
        return (
            <DialogConfirm
                title={I18n.t("Delete chart")}
                text={I18n.t("deleteChartText", this.state.charts[id]?.native?.chart?.name || id)}
                ok={I18n.t("Delete")}
                cancel={I18n.t("Cancel")}
                onClose={ok => {
                    this.setState({ deleteChart: null });
                    if (ok) {
                        this.deleteChart(id).catch(err => this.showError(String(err)));
                    }
                }}
            />
        );
    }

    renderContent() {
        if (!this.state.loaded) {
            return <Loader themeType={this.state.themeType} />;
        }
        const selected = this.state.selectedChart;
        const chart = selected ? this.state.charts[selected]?.native?.chart : null;

        return (
            <Box sx={{ display: "flex", height: "100%", bgcolor: "background.default", color: "text.primary" }}>
                <ResizablePanel
                    side="left"
                    storageKey="state-machine.chartListWidth"
                    defaultWidth={240}
                    minWidth={160}
                    maxWidth={600}
                >
                    {this.renderChartList()}
                </ResizablePanel>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    {selected && chart ? (
                        <ChartEditor
                            // a new editor for every chart, so no unsaved changes are carried over
                            key={selected}
                            chart={chart}
                            activeIds={this.state.activeIds}
                            onSave={newChart => this.saveChart(selected, newChart)}
                            socket={this.socket}
                            theme={this.state.theme}
                        />
                    ) : (
                        <Typography
                            sx={{ p: 2 }}
                            color="text.secondary"
                        >
                            {I18n.t("noChartsHelp")}
                        </Typography>
                    )}
                </Box>
                {this.renderNewChartDialog()}
                {this.renderDeleteDialog()}
                {this.renderError()}
                {this.renderToast()}
            </Box>
        );
    }

    render() {
        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>{this.renderContent()}</ThemeProvider>
            </StyledEngineProvider>
        );
    }
}

export default TabApp;
