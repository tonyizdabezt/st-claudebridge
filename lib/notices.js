/** @type {{ id: number, message: string }[]} */
const notices = [];
let lastId = 0;
const MAX_NOTICES = 20;

export function pushNotice(message) {
    notices.push({ id: ++lastId, message });
    if (notices.length > MAX_NOTICES) notices.shift();
}

/**
 * Logs a warning and shows it as a toast in ST.
 * @param {string} message
 * @param {...any} details
 */
export function warn(message, ...details) {
    console.warn(`[claude-bridge] ${message}`, ...details);
    pushNotice(message);
}

export function recentNotices() {
    return { lastId, notices };
}
