import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const THINKING_MODES = ['adaptive', 'enabled', 'disabled'];

const DEFAULTS = {
    port: 7373,
    secret: '',
    effort: 'medium',
    thinking: 'adaptive',
    thinkingBudget: 4096,
    showReasoning: true,
    resume: true,
    stripSdkIdentity: false,
};

/**
 * Settings the UI may change.
 * Port and secret are only editable in config.json.
 * @param {object} input
 * @returns {object}
 */
export function sanitizeEditable(input) {
    const out = {};
    if (EFFORT_LEVELS.includes(input?.effort)) out.effort = input.effort;
    if (THINKING_MODES.includes(input?.thinking)) out.thinking = input.thinking;
    const budget = Number(input?.thinkingBudget);
    if (Number.isInteger(budget) && budget >= 1024 && budget <= 64000) out.thinkingBudget = budget;
    if (typeof input?.showReasoning === 'boolean') out.showReasoning = input.showReasoning;
    if (typeof input?.resume === 'boolean') out.resume = input.resume;
    if (typeof input?.stripSdkIdentity === 'boolean') out.stripSdkIdentity = input.stripSdkIdentity;
    return out;
}

export class ConfigStore {
    /** @param {string} file */
    constructor(file) {
        this.file = file;
        let saved = {};
        try {
            saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
        }
        this.data = { ...DEFAULTS, ...saved };
        if (!Number.isInteger(this.data.port) || this.data.port < 1 || this.data.port > 65535) {
            this.data.port = DEFAULTS.port;
        }
        if (typeof this.data.secret !== 'string' || this.data.secret.length < 32) {
            this.data.secret = crypto.randomBytes(32).toString('hex');
        }
        this.save();
    }

    /** @param {object} patch */
    update(patch) {
        Object.assign(this.data, sanitizeEditable(patch));
        this.save();
        return this.data;
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 4));
    }
}
