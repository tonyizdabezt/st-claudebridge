import fs from 'node:fs';
import { warn } from './notices.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, all: null };
const MAX_DAILY_BUCKETS = 120;
const CHARS_PER_TOKEN = 4;
const TAG_TTL_MS = 30_000;
const MAX_TAG_LENGTH = 200;
const MAX_RANKED = 50;
const WEIGHT = { cw5: 1.25, cw1h: 2, cr: 0.1, out: 5 };

export class Meter {
    constructor(model) {
        this.model = model;
        this.started = Date.now();
        this.firstTokenAt = null;
        this.reset();
    }

    reset() {
        this.text = '';
        this.usage = null;
        this.modelUsage = null;
        this.cost = null;
    }

    token(text) {
        this.text += text;
        this.firstTokenAt ??= Date.now();
    }

    /** @param {number} [status] */
    entry(status) {
        const u = this.usage ?? {};
        const models = Object.values(this.modelUsage ?? {});
        const sum = key => models.reduce((n, m) => n + (m[key] ?? 0), 0);
        const final = models.length > 0;
        const entry = {
            t: this.started,
            model: this.model,
            in: final ? sum('inputTokens') : u.input_tokens ?? 0,
            cr: final ? sum('cacheReadInputTokens') : u.cache_read_input_tokens ?? 0,
            cw: final ? sum('cacheCreationInputTokens') : u.cache_creation_input_tokens ?? 0,
            out: final ? sum('outputTokens') : u.output_tokens ?? 0,
            cost: final ? sum('costUSD') : this.cost,
            ms: Date.now() - this.started,
            ttft: this.firstTokenAt ? this.firstTokenAt - this.started : null,
        };
        const m5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
        const h1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        if (m5 + h1) entry.cw1h = Math.round((entry.cw * h1) / (m5 + h1));
        if (!final) entry.est = 1;
        if (status) entry.err = status;
        return entry;
    }
}

const writes = r => {
    const h = r.cw1h ?? r.cw;
    return { h, m: r.cw - h };
};

const weighted = r => {
    const { h, m } = writes(r);
    return r.in + WEIGHT.cw5 * m + WEIGHT.cw1h * h + WEIGHT.cr * r.cr + WEIGHT.out * r.out;
};

function emptyTotals() {
    return { messages: 0, errors: 0, rateLimited: 0, stopped: 0, in: 0, cr: 0, cw: 0, out: 0, cost: 0, saved: 0, readSaved: 0, writeCost: 0 };
}

export class UsageLog {
    /**
     * @param {string} file
     * @param {(model: string, text: string) => Promise<number | null>} [countTokens]
     */
    constructor(file, countTokens) {
        this.file = file;
        this.countTokens = countTokens;
        this.pendingTag = null;
        /** @type {any[]} */
        this.records = [];
        try {
            for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try {
                    this.records.push(JSON.parse(line));
                } catch {
                }
            }
        } catch {
        }
    }

    /**
     * Remembers which chat the next generation belongs to.
     * @param {{ chat?: unknown, char?: unknown }} tag
     */
    tag(tag) {
        const clean = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TAG_LENGTH) : undefined);
        this.pendingTag = { chat: clean(tag?.chat), char: clean(tag?.char), at: Date.now() };
    }

    /** @returns {{ chat?: string, char?: string }} */
    takeTag() {
        const tag = this.pendingTag;
        this.pendingTag = null;
        if (!tag || Date.now() - tag.at > TAG_TTL_MS) return {};
        return JSON.parse(JSON.stringify({ chat: tag.chat, char: tag.char }));
    }

    /**
     * @param {object} entry From Meter#entry
     * @param {string} [text]
     */
    async record(entry, text = '') {
        if (entry.est) {
            let counted = null;
            try {
                counted = await this.countTokens?.(entry.model, text);
            } catch (error) {
                console.warn('[claude-bridge] Token count failed, estimating from length:', error.message);
            }
            entry.out = Math.max(entry.out, counted ?? Math.ceil(text.length / CHARS_PER_TOKEN));
            entry.est = counted == null ? 'chars' : 'counted';
        }
        this.records.push(entry);
        try {
            fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
        } catch (error) {
            warn(`Could not save usage stats: ${error.message}`);
        }
    }

    rates() {
        const acc = {};
        for (const r of this.records) {
            if (!r.cost) continue;
            const a = (acc[r.model] ??= { cost: 0, w: 0 });
            a.cost += r.cost;
            a.w += weighted(r);
        }
        const byModel = {};
        let cost = 0;
        let w = 0;
        for (const [model, a] of Object.entries(acc)) {
            if (a.w) byModel[model] = a.cost / a.w;
            cost += a.cost;
            w += a.w;
        }
        return { byModel, fallback: w ? cost / w : 0 };
    }

    /**
     * @param {{ range?: string, tz?: number }} query tz is Date#getTimezoneOffset() of the viewer
     */
    summary({ range = '7d', tz = 0 }) {
        if (!(range in RANGES)) range = '7d';
        const offset = (Number.isFinite(tz) ? tz : 0) * 60_000;
        const now = Date.now();
        const localDayStart = t => Math.floor((t - offset) / DAY) * DAY + offset;
        const { byModel, fallback } = this.rates();
        const costOf = r => r.cost ?? weighted(r) * (byModel[r.model] ?? fallback);

        const days = RANGES[range];
        let from;
        let unit;
        if (range === '24h') {
            from = Math.floor((now - DAY) / HOUR) * HOUR + HOUR;
            unit = 'hour';
        } else if (days) {
            from = localDayStart(now) - (days - 1) * DAY;
            unit = 'day';
        } else {
            from = localDayStart(this.records[0]?.t ?? now);
            unit = (now - from) / DAY > MAX_DAILY_BUCKETS ? 'week' : 'day';
        }
        const step = unit === 'hour' ? HOUR : unit === 'day' ? DAY : 7 * DAY;
        const count = Math.max(1, Math.ceil((now - from) / step));
        const buckets = Array.from({ length: count }, (_, i) => ({ t: from + i * step, ...emptyTotals() }));

        const totals = emptyTotals();
        const previous = days ? emptyTotals() : null;
        const prevFrom = from - (now - from);
        const models = {};
        const chars = {};
        const chats = {};
        const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
        const perf = { ms: 0, n: 0, ttft: 0, ttftN: 0, maxOut: 0 };

        const add = (target, r, cost) => {
            if (!r.err) target.messages++;
            else if (r.err === 499) target.stopped++;
            else {
                target.errors++;
                if (r.err === 429) target.rateLimited++;
            }
            target.in += r.in;
            target.cr += r.cr;
            target.cw += r.cw;
            target.out += r.out;
            target.cost += cost;
            const w = weighted(r);
            if (!w) return;
            const base = cost / w;
            const { h, m } = writes(r);
            const read = base * r.cr * (1 - WEIGHT.cr);
            const write = base * (m * (WEIGHT.cw5 - 1) + h * (WEIGHT.cw1h - 1));
            target.readSaved += read;
            target.writeCost += write;
            target.saved += read - write;
        };

        for (const r of this.records) {
            if (previous && r.t >= prevFrom && r.t < from) add(previous, r, costOf(r));
            if (r.t < from) continue;
            const cost = costOf(r);
            add(totals, r, cost);
            add(buckets[Math.min(count - 1, Math.floor((r.t - from) / step))], r, cost);

            const m = (models[r.model] ??= { model: r.model, ...emptyTotals() });
            add(m, r, cost);

            const who = (chars[r.char ?? ''] ??= { char: r.char ?? null, chats: new Set(), lastAt: 0, ...emptyTotals() });
            add(who, r, cost);
            who.lastAt = Math.max(who.lastAt, r.t);
            if (r.chat) who.chats.add(r.chat);
            const chat = (chats[r.chat ?? ''] ??= { chat: r.chat ?? null, char: r.char ?? null, lastAt: 0, ...emptyTotals() });
            add(chat, r, cost);
            chat.lastAt = Math.max(chat.lastAt, r.t);

            if (!r.err) {
                const local = new Date(r.t - offset);
                heatmap[(local.getUTCDay() + 6) % 7][local.getUTCHours()]++;
                perf.ms += r.ms;
                perf.n++;
                if (r.ttft != null) {
                    perf.ttft += r.ttft;
                    perf.ttftN++;
                }
                perf.maxOut = Math.max(perf.maxOut, r.out);
            }
        }

        const ranked = list => list.sort((a, b) => b.cost - a.cost);
        const rankedChars = ranked(Object.values(chars));
        const rankedChats = ranked(Object.values(chats));
        return {
            range,
            unit,
            from,
            to: now,
            firstAt: this.records[0]?.t ?? null,
            totals,
            previous,
            buckets,
            models: Object.values(models).sort((a, b) => b.cost - a.cost),
            heatmap,
            characters: { total: rankedChars.length, top: rankedChars.slice(0, MAX_RANKED).map(c => ({ ...c, chats: c.chats.size })) },
            chats: { total: rankedChats.length, top: rankedChats.slice(0, MAX_RANKED) },
            perRequest: {
                avgMs: perf.n ? perf.ms / perf.n : null,
                avgTtft: perf.ttftN ? perf.ttft / perf.ttftN : null,
                maxOut: perf.maxOut,
            },
        };
    }
}
