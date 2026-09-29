import { renderExtensionTemplateAsync } from '../../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { eventSource, event_types } from '../../../../events.js';

const SVG = 'http://www.w3.org/2000/svg';
const RANGE_STORAGE_KEY = 'claude_bridge_insights_range';
const RANK_STORAGE_KEY = 'claude_bridge_insights_rank';
const RANGES = ['24h', '7d', '30d', '90d', 'all'];
const RANGE_TEXT = {
    '24h': ['last 24 hours', 'previous 24 hours'],
    '7d': ['last 7 days', 'previous 7 days'],
    '30d': ['last 30 days', 'previous 30 days'],
    '90d': ['last 90 days', 'previous 90 days'],
    all: ['all time', ''],
};
const MAX_MODEL_ROWS = 5;
const MAX_RANK_ROWS = 10;
const SEGMENT_GAP = 2;

const fmt = {
    compact: new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }),
    whole: new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }),
    pct: new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }),
    usd: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    usdCents: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 }),
    usdCompact: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }),
    seconds: new Intl.NumberFormat(undefined, { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 }),
    hour: new Intl.DateTimeFormat(undefined, { hour: 'numeric' }),
    day: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }),
    dayLong: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    hourLong: new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }),
    relative: new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }),
    chatDate: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }),
    weekdayLong: new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }),
    clockHour: new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' }),
};

const money = v => (v > 0 && v < 0.01 ? '<$0.01' : fmt.usd.format(v));
const tokens = v => fmt.compact.format(Math.round(v));
const seconds = ms => (ms == null ? 'Not recorded' : fmt.seconds.format(ms / 1000));
const inputOf = t => t.in + t.cr + t.cw;
const missOf = t => t.in + t.cw;
const hitRateOf = t => (inputOf(t) ? t.cr / inputOf(t) : null);
const weekdayName = (i, long = false) => (long ? fmt.weekdayLong : fmt.weekday).format(Date.UTC(2024, 0, 1 + i));
const clockHour = h => fmt.clockHour.format(Date.UTC(2024, 0, 1, h));

function timeAgo(t) {
    const minutes = Math.round((t - Date.now()) / 60_000);
    if (minutes > -60) return fmt.relative.format(minutes, 'minute');
    if (minutes > -24 * 60) return fmt.relative.format(Math.round(minutes / 60), 'hour');
    return fmt.relative.format(Math.round(minutes / (24 * 60)), 'day');
}

function chatLabel(chat, char) {
    const name = char && chat.startsWith(`${char} - `) ? chat.slice(char.length + 3) : chat;
    const m = /^(\d{4})-(\d{2})-(\d{2})\s*@(\d{2})h\s*(\d{2})m/.exec(name);
    return m ? `Chat from ${fmt.chatDate.format(new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]))}` : name;
}

function modelName(id) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id ?? '');
    if (!m) return id === 'default' ? 'Default model' : String(id ?? 'Unknown');
    const family = m[1][0].toUpperCase() + m[1].slice(1);
    return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
}

function bucketLabel(t, unit, long = false) {
    if (unit === 'hour') return (long ? fmt.hourLong : fmt.hour).format(t);
    if (unit === 'week') return long ? `Week of ${fmt.day.format(t)}` : fmt.day.format(t);
    return (long ? fmt.dayLong : fmt.day).format(t);
}

function svg(name, attrs = {}, parent = null) {
    const el = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    parent?.appendChild(el);
    return el;
}

function niceScale(max) {
    if (!(max > 0)) return { max: 1, ticks: [0] };
    const raw = max / 3;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const top = step * Math.ceil(max / step);
    const ticks = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
    return { max: top, ticks };
}

function columnPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function themeMode() {
    const color = getComputedStyle(document.body).getPropertyValue('--SmartThemeBodyColor');
    const [r, g, b] = (color.match(/[\d.]+/g) ?? ['220', '220', '220']).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? 'dark' : 'light';
}

class Insights {
    /**
     * @param {HTMLElement} root
     * @param {(path: string) => Promise<any>} api
     */
    constructor(root, api) {
        this.root = root;
        this.api = api;
        this.tip = root.querySelector('.cbi-tip');
        this.data = null;
        this.seq = 0;
        this.drawn = false;
        this.width = 0;
        try {
            this.range = localStorage.getItem(RANGE_STORAGE_KEY);
        } catch {
        }
        if (!RANGES.includes(this.range)) this.range = '7d';
        try {
            this.rank = localStorage.getItem(RANK_STORAGE_KEY);
        } catch {
        }
        if (this.rank !== 'chats') this.rank = 'characters';

        root.dataset.mode = themeMode();
        root.querySelector('.cbi-range').addEventListener('click', event => {
            const button = event.target.closest('button[data-range]');
            if (!button || button.dataset.range === this.range) return;
            this.range = button.dataset.range;
            try {
                localStorage.setItem(RANGE_STORAGE_KEY, this.range);
            } catch {
            }
            this.load();
        });
        root.querySelector('.cbi-toggle').addEventListener('click', event => {
            const button = event.target.closest('button[data-rank]');
            if (!button || button.dataset.rank === this.rank) return;
            this.rank = button.dataset.rank;
            try {
                localStorage.setItem(RANK_STORAGE_KEY, this.rank);
            } catch {
            }
            if (this.data) this.renderRanking();
        });
        root.querySelector('.cbi-retry').addEventListener('click', () => this.load());
        this.resize = new ResizeObserver(() => {
            const width = root.clientWidth;
            if (!this.data || width === this.width) return;
            this.width = width;
            this.renderCharts();
        });
        this.resize.observe(root);
    }

    async load() {
        const seq = ++this.seq;
        for (const button of this.root.querySelectorAll('[data-range]')) {
            button.setAttribute('aria-pressed', String(button.dataset.range === this.range));
        }
        this.root.dataset.state = this.data ? 'refreshing' : 'loading';
        try {
            const data = await this.api(`/usage?range=${this.range}&tz=${new Date().getTimezoneOffset()}`);
            if (seq !== this.seq) return;
            this.data = data;
            this.render();
        } catch (error) {
            if (seq !== this.seq) return;
            this.message('Couldn’t load usage', error.message, true);
        }
    }

    message(title, body, retry = false) {
        const box = this.root.querySelector('.cbi-message');
        box.querySelector('.cbi-message-title').textContent = title;
        box.querySelector('.cbi-message-body').textContent = body;
        box.querySelector('.cbi-retry').hidden = !retry;
        this.root.dataset.state = 'message';
    }

    set(field, text) {
        const el = this.root.querySelector(`[data-field="${field}"]`);
        if (el) el.textContent = text;
    }

    delta(field, now, before) {
        const el = this.root.querySelector(`[data-delta="${field}"]`);
        el.replaceChildren();
        if (!this.data.previous || !before) return;
        const change = (now - before) / before;
        const dir = Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down';
        el.dataset.dir = dir;
        el.title = `vs ${RANGE_TEXT[this.range][1]}`;
        if (dir !== 'flat') {
            const icon = document.createElement('i');
            icon.className = `fa-solid fa-arrow-${dir === 'up' ? 'up' : 'down'}`;
            icon.setAttribute('aria-hidden', 'true');
            el.append(icon);
        }
        el.append(document.createTextNode(fmt.pct.format(Math.abs(change))));
    }

    render() {
        const d = this.data;
        if (d.firstAt == null) {
            this.message(
                'No usage recorded yet',
                'Send a message through ClaudeBridge to see its tokens, cache hits and API-equivalent value here.',
            );
            return;
        }
        this.root.dataset.state = 'ready';
        const t = d.totals;
        const p = d.previous;
        const [rangeText, previousText] = RANGE_TEXT[this.range];

        this.set('cost', money(t.cost));
        this.set('rangeLabel', rangeText);
        if (!p) {
            this.set('costNote', `Since ${fmt.date.format(d.firstAt)}`);
        } else if (!p.cost) {
            this.set('costNote', `No usage in the ${previousText}`);
        } else {
            const change = (t.cost - p.cost) / p.cost;
            this.set('costNote', `${change >= 0 ? '+' : '−'}${fmt.pct.format(Math.abs(change))} vs ${previousText} (${money(p.cost)})`);
        }

        this.set('messages', fmt.whole.format(t.messages));
        this.set('input', tokens(inputOf(t)));
        this.set('output', tokens(t.out));
        this.set('hit', tokens(t.cr));
        this.set('miss', tokens(missOf(t)));
        this.delta('messages', t.messages, p?.messages);
        this.delta('input', inputOf(t), p && inputOf(p));
        this.delta('output', t.out, p?.out);
        this.delta('hit', t.cr, p?.cr);
        this.delta('miss', missOf(t), p && missOf(p));

        const replies = t.messages + t.stopped;
        this.set('inputAside', replies ? `${tokens(inputOf(t) / replies)} per message` : '');
        this.set('outputAside', replies ? `${tokens(t.out / replies)} per message` : '');
        const rate = hitRateOf(t);
        this.set('hitRate', rate == null ? 'No data' : fmt.pct.format(rate));
        this.set('saved', money(t.saved));
        this.set('cacheAside', `${tokens(t.cw)} written`);

        this.renderHeatmap();
        this.renderModels();
        this.renderFacts();
        this.renderRanking();
        this.width = this.root.clientWidth;
        this.renderCharts();
    }

    renderCharts() {
        const { buckets, unit } = this.data;
        const q = name => this.root.querySelector(`[data-chart="${name}"]`);
        const inputSeries = [
            { label: 'Cache hit', color: 'var(--cbi-hit)', value: b => b.cr },
            { label: 'Cache write', color: 'var(--cbi-write)', value: b => b.cw },
            { label: 'Uncached', color: 'var(--cbi-miss)', value: b => b.in },
        ];
        this.chart(q('cost'), {
            kind: 'line', buckets, unit, height: 200, format: money, axis: v => fmt.usdCompact.format(v),
            series: [{ label: 'Value', color: 'var(--cbi-accent)', value: b => b.cost }],
            label: `API-equivalent value per ${unit}`,
            draw: !this.drawn,
        });
        this.chart(q('input'), {
            kind: 'columns', buckets, unit, height: 170, format: tokens, axis: tokens, series: inputSeries,
            label: `Input tokens per ${unit}, split by cache hit, cache write and uncached`,
        });
        this.chart(q('output'), {
            kind: 'columns', buckets, unit, height: 170, format: tokens, axis: tokens,
            series: [{ label: 'Output', color: 'var(--cbi-output)', value: b => b.out }],
            label: `Output tokens per ${unit}`,
        });
        this.chart(q('hitRate'), {
            kind: 'line', buckets, unit, height: 130, format: v => fmt.pct.format(v), axis: v => fmt.pct.format(v), max: 1,
            series: [{ label: 'Hit rate', color: 'var(--cbi-accent)', value: hitRateOf }],
            label: `Cache hit rate per ${unit}`,
        });
        this.drawn = true;

        const legend = this.root.querySelector('[data-legend="input"]');
        legend.replaceChildren(...inputSeries.map(s => {
            const item = document.createElement('li');
            const key = document.createElement('i');
            key.className = 'cbi-key';
            key.style.setProperty('--key', s.color);
            const value = document.createElement('b');
            value.textContent = tokens(buckets.reduce((n, b) => n + s.value(b), 0));
            item.append(key, document.createTextNode(s.label), value);
            return item;
        }));
    }

    /**
     * @param {HTMLElement} host
     * @param {object} o
     */
    chart(host, o) {
        host.replaceChildren();
        const width = host.clientWidth;
        if (!width) return;
        const { buckets, series } = o;
        const n = buckets.length;
        const values = buckets.map(b => series.map(s => s.value(b)));
        const peak = Math.max(0, ...values.map(row => (o.kind === 'columns' ? row.reduce((a, v) => a + (v ?? 0), 0) : Math.max(0, ...row.map(v => v ?? 0)))));
        const scale = o.max ? { max: o.max, ticks: [0, o.max / 2, o.max] } : niceScale(peak);
        const tickText = scale.ticks.map(o.axis);
        const pad = { top: 10, right: 10, bottom: 24, left: Math.max(...tickText.map(s => s.length)) * 6.4 + 10 };
        const pw = width - pad.left - pad.right;
        const ph = o.height - pad.top - pad.bottom;
        const band = pw / n;
        const x = i => pad.left + band * (i + 0.5);
        const y = v => pad.top + ph - (v / scale.max) * ph;

        const root = svg('svg', { width, height: o.height, viewBox: `0 0 ${width} ${o.height}`, tabindex: 0, role: 'img', 'aria-label': o.label, class: 'cbi-svg' }, host);
        scale.ticks.forEach((tick, i) => {
            svg('line', { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), class: i === 0 ? 'cbi-baseline' : 'cbi-gridline' }, root);
            svg('text', { x: pad.left - 8, y: y(tick), class: 'cbi-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, root).textContent = tickText[i];
        });
        const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));
        for (let i = n - 1; i >= 0; i -= every) {
            svg('text', { x: x(i), y: o.height - 6, class: 'cbi-tick', 'text-anchor': i === n - 1 && n > 1 ? 'end' : 'middle' }, root)
                .textContent = bucketLabel(buckets[i].t, o.unit);
        }

        const focus = svg('rect', { x: 0, y: pad.top, width: band, height: ph, class: 'cbi-focus-band', visibility: 'hidden' }, root);
        const marks = svg('g', {}, root);
        let marker = null;

        if (o.kind === 'columns') {
            const barW = Math.min(24, Math.max(2, band * 0.64));
            values.forEach((row, i) => {
                let base = 0;
                const drawn = [];
                row.forEach((v, s) => {
                    if (!(v > 0)) return;
                    drawn.push({ s, from: base, to: base + v });
                    base += v;
                });
                drawn.forEach((seg, k) => {
                    const top = y(seg.to);
                    let h = y(seg.from) - top;
                    if (k > 0) h -= SEGMENT_GAP;
                    if (h <= 0.5) return;
                    const radius = k === drawn.length - 1 ? 4 : 0;
                    svg('path', { d: columnPath(x(i) - barW / 2, top, barW, h, radius), class: 'cbi-bar' }, marks).style.fill = series[seg.s].color;
                });
            });
        } else {
            const s = series[0];
            const points = values.map((row, i) => (row[0] == null ? null : [x(i), y(row[0])]));
            const runs = [];
            let run = [];
            for (const pt of points) {
                if (pt) run.push(pt);
                else if (run.length) {
                    runs.push(run);
                    run = [];
                }
            }
            if (run.length) runs.push(run);
            for (const r of runs) {
                const line = r.map((pt, i) => `${i ? 'L' : 'M'}${pt[0]},${pt[1]}`).join('');
                const area = svg('path', { d: `${line}L${r.at(-1)[0]},${y(0)}L${r[0][0]},${y(0)}Z`, class: 'cbi-area' }, marks);
                area.style.fill = s.color;
                const path = svg('path', { d: line, class: 'cbi-line', pathLength: 1 }, marks);
                path.style.stroke = s.color;
                if (o.draw) {
                    path.classList.add('cbi-draw');
                    area.classList.add('cbi-draw-area');
                }
                if (r.length === 1) svg('circle', { cx: r[0][0], cy: r[0][1], r: 3, class: 'cbi-dot' }, marks).style.fill = s.color;
            }
            const last = points.findLast(Boolean);
            if (last) svg('circle', { cx: last[0], cy: last[1], r: 4, class: 'cbi-dot cbi-end' }, marks).style.fill = s.color;
            marker = svg('g', { visibility: 'hidden' }, root);
            svg('line', { y1: pad.top, y2: pad.top + ph, class: 'cbi-crosshair' }, marker);
            svg('circle', { r: 4, class: 'cbi-dot cbi-end' }, marker).style.fill = s.color;
        }

        const show = i => {
            if (o.kind === 'columns') {
                focus.setAttribute('x', String(pad.left + band * i));
                focus.setAttribute('width', String(band));
                focus.setAttribute('visibility', 'visible');
            } else {
                const v = values[i][0];
                marker.querySelector('line').setAttribute('x1', String(x(i)));
                marker.querySelector('line').setAttribute('x2', String(x(i)));
                const dot = marker.querySelector('circle');
                dot.setAttribute('cx', String(x(i)));
                dot.setAttribute('cy', String(y(v ?? 0)));
                dot.setAttribute('visibility', v == null ? 'hidden' : 'inherit');
                marker.setAttribute('visibility', 'visible');
            }
            const rows = series.map((s, k) => ({ color: s.color, label: s.label, value: values[i][k] == null ? 'No data' : o.format(values[i][k]) }));
            if (o.kind === 'columns' && series.length > 1) {
                rows.reverse();
                rows.push({ label: 'Total', value: o.format(values[i].reduce((a, v) => a + v, 0)) });
            }
            const hostBox = host.getBoundingClientRect();
            this.showTip(bucketLabel(buckets[i].t, o.unit, true), rows, hostBox.left + x(i), hostBox.top + pad.top, band / 2 + 8);
        };
        const hide = () => {
            focus.setAttribute('visibility', 'hidden');
            marker?.setAttribute('visibility', 'hidden');
            this.hideTip();
        };
        const indexAt = clientX => {
            const i = Math.floor((clientX - root.getBoundingClientRect().left - pad.left) / band);
            return Math.min(n - 1, Math.max(0, i));
        };

        let active = n - 1;
        root.addEventListener('pointermove', event => show(active = indexAt(event.clientX)));
        root.addEventListener('pointerleave', hide);
        root.addEventListener('focus', () => show(active));
        root.addEventListener('blur', hide);
        root.addEventListener('keydown', event => {
            const step = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n }[event.key];
            if (event.key === 'Escape') return hide();
            if (step == null) return;
            event.preventDefault();
            show(active = Math.min(n - 1, Math.max(0, active + step)));
        });
    }

    renderHeatmap() {
        const grid = this.root.querySelector('[data-heatmap]');
        const { heatmap } = this.data;
        const max = Math.max(0, ...heatmap.flat());
        let busiest = null;
        grid.replaceChildren();
        grid.append(document.createElement('span'));
        for (let h = 0; h < 24; h++) {
            const label = document.createElement('span');
            label.className = 'cbi-heat-hour';
            if (h % 6 === 0) label.textContent = clockHour(h);
            grid.append(label);
        }
        heatmap.forEach((row, day) => {
            const label = document.createElement('span');
            label.className = 'cbi-heat-day';
            label.textContent = weekdayName(day);
            grid.append(label);
            row.forEach((count, hour) => {
                const cell = document.createElement('span');
                cell.className = 'cbi-heat-cell';
                cell.dataset.level = String(count ? Math.ceil((count / max) * 4) : 0);
                cell.dataset.day = String(day);
                cell.dataset.hour = String(hour);
                cell.dataset.count = String(count);
                grid.append(cell);
                if (count && (!busiest || count > busiest.count)) busiest = { day, hour, count };
            });
        });
        grid.setAttribute('role', 'img');
        grid.setAttribute('aria-label', busiest
            ? `Messages by weekday and hour. Busiest: ${weekdayName(busiest.day, true)} at ${clockHour(busiest.hour)}.`
            : 'Messages by weekday and hour. No messages in this range.');
        this.set('peak', busiest ? `Busiest: ${weekdayName(busiest.day)}, ${clockHour(busiest.hour)}` : '');

        grid.onpointerover = event => {
            const cell = event.target.closest('.cbi-heat-cell');
            if (!cell) return this.hideTip();
            const count = Number(cell.dataset.count);
            const hour = Number(cell.dataset.hour);
            const box = cell.getBoundingClientRect();
            this.showTip(`${weekdayName(Number(cell.dataset.day), true)}, ${clockHour(hour)} – ${clockHour((hour + 1) % 24)}`,
                [{ label: count === 1 ? 'message' : 'messages', value: fmt.whole.format(count) }], box.left + box.width / 2, box.top, box.width / 2 + 6);
        };
        grid.onpointerleave = () => this.hideTip();
    }

    renderModels() {
        const list = this.root.querySelector('[data-models]');
        const models = [...this.data.models];
        if (models.length > MAX_MODEL_ROWS + 1) {
            const rest = models.splice(MAX_MODEL_ROWS);
            const other = { model: null, messages: 0, stopped: 0, in: 0, cr: 0, cw: 0, out: 0, cost: 0 };
            for (const m of rest) for (const key of Object.keys(other)) if (key !== 'model') other[key] += m[key];
            models.push(other);
        }
        const total = this.data.totals.cost;
        const top = Math.max(0, ...models.map(m => m.cost));
        list.replaceChildren(...models.map(m => {
            const item = document.createElement('li');
            const head = document.createElement('div');
            head.className = 'cbi-model-head';
            const name = document.createElement('span');
            name.textContent = m.model === null ? `${this.data.models.length - MAX_MODEL_ROWS} other models` : modelName(m.model);
            name.title = m.model ?? '';
            const value = document.createElement('b');
            value.textContent = money(m.cost);
            head.append(name, value);
            const bar = document.createElement('div');
            bar.className = 'cbi-model-bar';
            const fill = document.createElement('i');
            fill.style.width = `${top ? (m.cost / top) * 100 : 0}%`;
            bar.append(fill);
            const meta = document.createElement('div');
            meta.className = 'cbi-model-meta';
            const share = total ? `${fmt.pct.format(m.cost / total)} of value · ` : '';
            meta.textContent = `${share}${fmt.whole.format(m.messages)} ${m.messages === 1 ? 'message' : 'messages'} · ${tokens(inputOf(m) + m.out)} tokens`;
            item.append(head, bar, meta);
            return item;
        }));
        if (!models.length) {
            const empty = document.createElement('li');
            empty.className = 'cbi-none';
            empty.textContent = 'No messages in this range.';
            list.append(empty);
        }
    }

    renderRanking() {
        const chats = this.rank === 'chats';
        for (const button of this.root.querySelectorAll('[data-rank]')) {
            button.setAttribute('aria-pressed', String(button.dataset.rank === this.rank));
        }
        this.root.querySelector('[data-rank-heading]').textContent = chats ? 'Chat' : 'Character';
        const { total, top } = this.data[this.rank];
        const rows = top.slice(0, MAX_RANK_ROWS);
        const peak = Math.max(0, ...rows.map(r => r.cost));
        const cell = (text, className = '') => {
            const td = document.createElement('td');
            if (className) td.className = className;
            td.textContent = text;
            return td;
        };

        this.root.querySelector('[data-rank-rows]').replaceChildren(...rows.map(r => {
            const tr = document.createElement('tr');
            const name = document.createElement('td');
            name.className = 'cbi-rank-name';
            const primary = document.createElement('span');
            const secondary = document.createElement('small');
            const linked = chats ? r.chat : r.char;
            primary.textContent = (chats ? r.char ?? r.chat : r.char) ?? 'Not linked to a chat';
            if (!linked) {
                primary.className = 'cbi-rank-unlinked';
                secondary.textContent = 'Sent before chat tracking, or from outside SillyTavern';
            } else if (chats) {
                secondary.textContent = r.char ? chatLabel(r.chat, r.char) : '';
            } else {
                secondary.textContent = `${fmt.whole.format(r.chats)} ${r.chats === 1 ? 'chat' : 'chats'}`;
            }
            primary.title = primary.textContent;
            secondary.title = secondary.textContent;
            name.append(primary, secondary);

            const value = document.createElement('td');
            value.className = 'cbi-rank-value';
            const bar = document.createElement('div');
            bar.className = 'cbi-model-bar';
            const fill = document.createElement('i');
            fill.style.width = `${peak ? (r.cost / peak) * 100 : 0}%`;
            bar.append(fill);
            const amount = document.createElement('b');
            amount.textContent = money(r.cost);
            value.append(amount, bar);

            tr.append(
                name,
                value,
                cell(fmt.whole.format(r.messages), 'cbi-num cbi-col-extra'),
                cell(tokens(inputOf(r) + r.out), 'cbi-num cbi-col-extra'),
                cell(timeAgo(r.lastAt), 'cbi-num cbi-col-extra'),
            );
            return tr;
        }));

        const more = this.root.querySelector('[data-rank-more]');
        const hidden = total - rows.length;
        more.hidden = rows.length > 0 && hidden <= 0;
        more.textContent = rows.length === 0
            ? 'No messages in this range.'
            : `${fmt.whole.format(hidden)} more ${chats ? (hidden === 1 ? 'chat' : 'chats') : (hidden === 1 ? 'character' : 'characters')} with less usage.`;
    }

    renderFacts() {
        const t = this.data.totals;
        const r = this.data.perRequest;
        const replies = t.messages + t.stopped;
        const avg = v => (replies ? tokens(v / replies) : 'No data');
        const facts = [
            ['Prompt size', avg(inputOf(t)), 'average input tokens'],
            ['Reply length', avg(t.out), 'average output tokens'],
            ['Longest reply', tokens(r.maxOut), 'output tokens'],
            ['Cost per message', replies ? (t.cost / replies < 1 ? fmt.usdCents : fmt.usd).format(t.cost / replies) : 'No data', 'average API-equivalent value'],
            ['Response time', seconds(r.avgMs), 'average, start to finish'],
            ['First token', seconds(r.avgTtft), 'average wait'],
            ['Stopped early', fmt.whole.format(t.stopped), 'cut off before finishing'],
            ['Errors', fmt.whole.format(t.errors), t.rateLimited ? `${fmt.whole.format(t.rateLimited)} hit the plan limit` : 'failed requests'],
        ];
        this.root.querySelector('[data-facts]').replaceChildren(...facts.map(([label, value, note]) => {
            const row = document.createElement('div');
            const dt = document.createElement('dt');
            dt.textContent = label;
            const dd = document.createElement('dd');
            const b = document.createElement('b');
            b.textContent = value;
            const small = document.createElement('small');
            small.textContent = note;
            dd.append(b, small);
            row.append(dt, dd);
            return row;
        }));
    }

    /**
     * @param {{ label: string, value: string, color?: string }[]} rows
     * @param {number} clientX
     * @param {number} clientY
     * @param {number} offset
     */
    showTip(title, rows, clientX, clientY, offset) {
        const tip = this.tip;
        const head = document.createElement('div');
        head.className = 'cbi-tip-title';
        head.textContent = title;
        tip.replaceChildren(head, ...rows.map(row => {
            const line = document.createElement('div');
            line.className = 'cbi-tip-row';
            if (row.color) {
                const key = document.createElement('i');
                key.className = 'cbi-tip-key';
                key.style.setProperty('--key', row.color);
                line.append(key);
            }
            const value = document.createElement('b');
            value.textContent = row.value;
            const label = document.createElement('span');
            label.textContent = row.label;
            line.append(value, label);
            return line;
        }));
        tip.hidden = false;
        const box = this.root.getBoundingClientRect();
        const w = tip.offsetWidth;
        let left = clientX - box.left + offset;
        if (left + w > box.width) left = clientX - box.left - offset - w;
        tip.style.left = `${Math.max(0, left)}px`;
        tip.style.top = `${clientY - box.top}px`;
    }

    hideTip() {
        this.tip.hidden = true;
    }

    destroy() {
        this.seq++;
        this.resize.disconnect();
    }
}

/**
 * Opens the Usage insights popup.
 * @param {{ api: (path: string) => Promise<any>, templatePath: string }} deps
 */
export async function openInsights({ api, templatePath }) {
    const template = document.createElement('template');
    template.innerHTML = (await renderExtensionTemplateAsync(templatePath, 'insights')).trim();
    const root = /** @type {HTMLElement} */ (template.content.firstElementChild);
    const insights = new Insights(root, api);
    const refresh = () => insights.load();
    eventSource.on(event_types.GENERATION_ENDED, refresh);
    const closed = callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' });
    insights.load();
    try {
        await closed;
    } finally {
        eventSource.removeListener(event_types.GENERATION_ENDED, refresh);
        insights.destroy();
    }
}
