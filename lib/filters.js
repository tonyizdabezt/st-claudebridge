/**
 * Streaming text filters. The Agent SDK has no stop sequences, so they are
 * enforced on the output stream here.
 */

export class StopScanner {
    constructor(stops) {
        this.stops = (Array.isArray(stops) ? stops : []).filter(s => typeof s === 'string' && s.length > 0);
        this.holdback = Math.max(0, ...this.stops.map(s => s.length)) - 1;
        this.buffer = '';
        this.stopped = false;
        /** @type {string | null} */
        this.matched = null;
    }

    push(text) {
        if (this.stopped) return '';
        if (this.stops.length === 0) return text;
        this.buffer += text;
        let cut = -1;
        for (const stop of this.stops) {
            const index = this.buffer.indexOf(stop);
            if (index !== -1 && (cut === -1 || index < cut)) {
                cut = index;
                this.matched = stop;
            }
        }
        if (cut !== -1) {
            this.stopped = true;
            const out = this.buffer.slice(0, cut);
            this.buffer = '';
            return out;
        }
        const safe = Math.max(0, this.buffer.length - this.holdback);
        const out = this.buffer.slice(0, safe);
        this.buffer = this.buffer.slice(safe);
        return out;
    }

    flush() {
        const out = this.stopped ? '' : this.buffer;
        this.buffer = '';
        return out;
    }
}
