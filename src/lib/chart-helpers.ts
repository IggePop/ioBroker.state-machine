/*
 * Helper functions which can be used in conditions, actions and function blocks.
 * The descriptions are shared by the editor (completion), the validation and the code generator,
 * the runtime implements them (see ChartRuntime.createHelpers()).
 */

export interface HelperDescription {
    signature: string;
    description: string;
}

export const HELPERS: Record<string, HelperDescription> = {
    log: {
        signature: 'log(message, level = "info")',
        description: 'Writes a message to the ioBroker log, level "debug", "info", "warn" or "error"',
    },
    setState: {
        signature: "setState(id, value, ack = false)",
        description: "Writes a value to any ioBroker state",
    },
    setStateDelayed: {
        signature: "setStateDelayed(id, value, delayMs, ack = false)",
        description: "Writes a value after a delay, cancelled when the chart stops",
    },
    sendTo: {
        signature: "sendTo(instance, command, message)",
        description: 'Sends a message to an adapter, e.g. sendTo("telegram.0", "send", { text: "Hello" })',
    },
    isTimeBetween: {
        signature: 'isTimeBetween("22:00", "06:00")',
        description: "true if the current time is in the range, also over midnight",
    },
    isDaytime: {
        signature: "isDaytime()",
        description: "true between sunrise and sunset, at the location of the ioBroker system settings",
    },
    astroTime: {
        signature: 'astroTime("sunset", offsetMinutes = 0)',
        description:
            "Time of an astro event today: sunrise, sunset, dawn, dusk, solarNoon, nauticalDawn, nauticalDusk, goldenHour, goldenHourEnd, night, nightEnd",
    },
};

/**
 * @param time "HH:mm" or "HH:mm:ss"
 * @returns seconds since midnight
 * @throws {Error} if the time is invalid
 */
export function parseTime(time: string): number {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(time).trim());
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) {
        throw new Error(`Invalid time "${time}", expected e.g. "22:30"`);
    }
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

/**
 * @param start "HH:mm", inclusive
 * @param end "HH:mm", exclusive. A range over midnight ends on the next day.
 * @param now The time to check
 */
export function isTimeBetween(start: string, end: string, now = new Date()): boolean {
    const from = parseTime(start);
    const to = parseTime(end);
    const current = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    return from <= to ? current >= from && current < to : current >= from || current < to;
}
