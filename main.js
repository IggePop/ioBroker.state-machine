"use strict";

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const { ChartRuntime } = require("./lib/chart-runtime");

class StateMachine extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: "state-machine",
        });
        /** @type {Map<string, ChartRuntime>} running charts by chart ID */
        this.runtimes = new Map();
        /** @type {Set<string>} foreign states we are subscribed to */
        this.subscribedInputs = new Set();
        /** chart (re)starts are executed one after another */
        this.chartQueue = Promise.resolve();
        /** @type {{ latitude: number; longitude: number } | null} for the astro helper functions */
        this.location = null;

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        await this.setObjectNotExistsAsync("charts", {
            type: "folder",
            common: { name: "Charts" },
            native: {},
        });
        await this.loadLocation();

        const objects = await this.getForeignObjectsAsync(`${this.namespace}.charts.*`, "channel");
        for (const [id, obj] of Object.entries(objects)) {
            const chartId = this.getChartId(id);
            if (chartId) {
                // continue where the chart was before the adapter stopped
                await this.startChart(chartId, obj, true);
            }
        }

        // the editor saves charts as objects, restart a chart (in its initial state) whenever it changes
        this.subscribeObjects("charts.*");
    }

    /**
     * Reads the location of the ioBroker system settings, used by isDaytime() and astroTime()
     */
    async loadLocation() {
        const config = await this.getForeignObjectAsync("system.config");
        const latitude = parseFloat(String(config?.common?.latitude ?? ""));
        const longitude = parseFloat(String(config?.common?.longitude ?? ""));
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            this.location = { latitude, longitude };
        } else {
            this.log.info("No location configured in the system settings, isDaytime() and astroTime() do not work");
        }
    }

    /**
     * Extracts the chart ID from the ID of a chart object
     *
     * @param {string} id - Object ID
     * @returns {string | undefined} undefined if the ID is no chart object
     */
    getChartId(id) {
        const prefix = `${this.namespace}.charts.`;
        if (!id.startsWith(prefix)) {
            return undefined;
        }
        const chartId = id.substring(prefix.length);
        return chartId.includes(".") ? undefined : chartId;
    }

    /**
     * @param {string} chartId - Chart ID
     * @param {ioBroker.Object | null | undefined} obj - Chart object
     * @param {boolean} [restore] - Continue with the persisted state instead of the initial state
     */
    async startChart(chartId, obj, restore = false) {
        const chart = obj?.type === "channel" ? obj.native?.chart : undefined;
        if (!chart) {
            return;
        }

        await this.createChartStates(chartId);
        // e.g. a new chart, which was just created in the editor: nothing to execute, but no error either
        const empty = !chart.states?.length;
        if (!chart.enabled || empty) {
            if (empty) {
                this.log.warn(`Chart "${chart.name}" has no states, it is not started`);
            } else {
                this.log.info(`Chart "${chart.name}" is paused`);
            }
            // no state is active, so the editor does not highlight the last active state anymore
            await this.setState(`charts.${chartId}.activeState`, "", true);
            await this.setState(`charts.${chartId}.activeStateIds`, "[]", true);
            return;
        }

        const runtime = new ChartRuntime(chartId, chart, {
            readState: async id => (await this.getForeignStateAsync(id))?.val ?? null,
            writeState: async (id, val, ack = false) => {
                await this.setForeignStateAsync(id, val, ack);
            },
            sendTo: (instance, command, message) => this.sendTo(instance, command, message),
            getLocation: () => this.location,
            onActiveChange: ({ names, ids }) => {
                this.setState(`charts.${chartId}.activeState`, names, true);
                this.setState(`charts.${chartId}.activeStateIds`, JSON.stringify(ids), true);
            },
            persist: data => {
                this.setState(`charts.${chartId}.snapshot`, JSON.stringify(data), true);
            },
            loadPersisted: async () => {
                const state = await this.getStateAsync(`charts.${chartId}.snapshot`);
                return typeof state?.val === "string" && state.val ? JSON.parse(state.val) : null;
            },
            log: this.log,
        });
        try {
            await runtime.start({ restore });
        } catch (err) {
            this.log.error(`Cannot start chart "${chart.name}": ${err.message}`);
            return;
        }
        this.runtimes.set(chartId, runtime);
        this.updateSubscriptions();
        this.log.info(`Chart "${chart.name}" started`);
    }

    /**
     * @param {string} chartId - Chart ID
     */
    stopChart(chartId) {
        const runtime = this.runtimes.get(chartId);
        if (runtime) {
            runtime.stop();
            this.runtimes.delete(chartId);
            this.updateSubscriptions();
        }
    }

    /**
     * Creates the states which show the current status of a chart
     *
     * @param {string} chartId - Chart ID
     */
    async createChartStates(chartId) {
        await this.setObjectNotExistsAsync(`charts.${chartId}.activeState`, {
            type: "state",
            common: {
                name: "Active state",
                type: "string",
                role: "text",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`charts.${chartId}.snapshot`, {
            type: "state",
            common: {
                name: "Stored state of the chart, restored after a restart of the adapter",
                type: "string",
                role: "json",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`charts.${chartId}.activeStateIds`, {
            type: "state",
            common: {
                name: "IDs of all active states",
                type: "string",
                role: "json",
                read: true,
                write: false,
            },
            native: {},
        });
    }

    /**
     * Subscribes to all inputs of the running charts and unsubscribes from the ones no longer used
     */
    updateSubscriptions() {
        const needed = new Set([...this.runtimes.values()].flatMap(runtime => runtime.inputStateIds));
        for (const id of needed) {
            if (!this.subscribedInputs.has(id)) {
                this.subscribeForeignStates(id);
            }
        }
        for (const id of this.subscribedInputs) {
            if (!needed.has(id)) {
                this.unsubscribeForeignStates(id);
            }
        }
        this.subscribedInputs = needed;
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            for (const runtime of this.runtimes.values()) {
                runtime.stop();
            }
            this.runtimes.clear();
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     *
     * @param {string} id - Object ID
     * @param {ioBroker.Object | null | undefined} obj - Object
     */
    onObjectChange(id, obj) {
        const chartId = this.getChartId(id);
        if (!chartId) {
            return;
        }
        this.chartQueue = this.chartQueue
            .then(async () => {
                this.stopChart(chartId);
                await this.startChart(chartId, obj);
            })
            .catch(err => this.log.error(`Cannot restart chart ${chartId}: ${err.message}`));
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - State ID
     * @param {ioBroker.State | null | undefined} state - State object
     */
    onStateChange(id, state) {
        if (!state) {
            return;
        }
        for (const runtime of this.runtimes.values()) {
            runtime.handleInput(id, state.val, { ack: state.ack });
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new StateMachine(options);
} else {
    // otherwise start the instance directly
    new StateMachine();
}
