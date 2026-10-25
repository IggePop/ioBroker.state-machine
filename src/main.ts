/*
 * Created with @iobroker/create-adapter v3.1.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from "@iobroker/adapter-core";
import type { Chart } from "./lib/chart-model";
import { ChartRuntime } from "./lib/chart-runtime";
import type { Location } from "./lib/chart-runtime";

class Statechart extends utils.Adapter {
    /** running charts by chart ID */
    private runtimes = new Map<string, ChartRuntime>();
    /** foreign states we are subscribed to */
    private subscribedInputs = new Set<string>();
    /** chart (re)starts are executed one after another */
    private chartQueue = Promise.resolve();
    /** for the astro helper functions */
    private location: Location | null = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "statechart",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
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
    private async loadLocation(): Promise<void> {
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
     * @param id Object ID
     * @returns undefined if the ID is no chart object
     */
    private getChartId(id: string): string | undefined {
        const prefix = `${this.namespace}.charts.`;
        if (!id.startsWith(prefix)) {
            return undefined;
        }
        const chartId = id.substring(prefix.length);
        return chartId.includes(".") ? undefined : chartId;
    }

    /**
     * @param chartId Chart ID
     * @param obj Chart object
     * @param restore Continue with the persisted state instead of the initial state
     */
    private async startChart(chartId: string, obj: ioBroker.Object | null | undefined, restore = false): Promise<void> {
        const chart: Chart | undefined = obj?.type === "channel" ? obj.native?.chart : undefined;
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
                void this.setState(`charts.${chartId}.activeState`, names, true);
                void this.setState(`charts.${chartId}.activeStateIds`, JSON.stringify(ids), true);
            },
            persist: data => {
                void this.setState(`charts.${chartId}.snapshot`, JSON.stringify(data), true);
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
     * @param chartId Chart ID
     */
    private stopChart(chartId: string): void {
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
     * @param chartId Chart ID
     */
    private async createChartStates(chartId: string): Promise<void> {
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
    private updateSubscriptions(): void {
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
     * @param callback Callback function
     */
    private onUnload(callback: () => void): void {
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
     * @param id Object ID
     * @param obj Object
     */
    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
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
     * @param id State ID
     * @param state State object
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
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
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Statechart(options);
} else {
    // otherwise start the instance directly
    (() => new Statechart())();
}
