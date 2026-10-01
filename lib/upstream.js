import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { SYSTEM_OPEN, SYSTEM_CLOSE, SYSTEM_SPLIT, supportsMidSystem } from './convert.js';
import { warn } from './notices.js';

const UPSTREAM_HOST = 'api.anthropic.com';
const REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;
const SYSTEM_NOTE = new RegExp(`^${SYSTEM_OPEN}([\\s\\S]*)${SYSTEM_CLOSE}$`);
const ROLE_UNSUPPORTED = /role 'system' is not supported on this model/;
const SDK_IDENTITY = /^\s*You are a Claude agent, built on Anthropic's Claude Agent SDK\.\s*$/;

/** @type {string | null} */
let baseUrl = null;
let countHeaders = null;
/** @type {Map<string, Promise<number>>} */
const countOverhead = new Map();

export function upstreamUrl() {
    return baseUrl;
}

function splitSystemNotes(msg, promote) {
    const out = [];
    for (const b of msg.content) {
        const note = b?.type === 'text' && b.text?.includes(SYSTEM_OPEN) ? SYSTEM_NOTE.exec(b.text) : null;
        const role = promote && note ? 'system' : msg.role;
        const block = note ? { ...b, text: promote ? note[1] : b.text.replaceAll(SYSTEM_OPEN, '').replaceAll(SYSTEM_CLOSE, '') } : b;
        const last = out.at(-1);
        if (role !== 'system' && last?.role === role) last.content.push(block);
        else out.push(role === 'system' ? { role, content: [block] } : { ...msg, content: [block] });
    }
    return out;
}

function splitSystemPrompt(system) {
    if (typeof system === 'string') {
        if (!system.includes(SYSTEM_SPLIT)) return system;
        system = [{ type: 'text', text: system }];
    }
    if (!Array.isArray(system)) return system;
    return system.flatMap(b => {
        if (b?.type !== 'text' || !b.text?.includes(SYSTEM_SPLIT)) return [b];
        const { cache_control, ...rest } = b;
        const pieces = [];
        for (const text of b.text.split(SYSTEM_SPLIT)) {
            if (pieces.length > 0 && !text.trim()) pieces[pieces.length - 1] += text;
            else if (pieces.length > 0 && !pieces[pieces.length - 1].trim()) pieces[pieces.length - 1] += text;
            else pieces.push(text);
        }
        const blocks = pieces.map(text => ({ ...rest, text }));
        if (cache_control) blocks[blocks.length - 1].cache_control = cache_control;
        return blocks;
    });
}

/**
 * Removes the host context Claude Code adds: `<system-reminder>` blocks on user
 * messages and `system`-role messages (environment, model identity, date).
 * @param {any} body Messages API request body
 * @param {{ sdkIdentity?: boolean, midSystem?: boolean }} [options]
 */
export function stripHostContext(body, { sdkIdentity = false, midSystem = false } = {}) {
    if (sdkIdentity && Array.isArray(body?.system)) {
        body.system = body.system.filter(b => !(b?.type === 'text' && SDK_IDENTITY.test(b.text ?? '')));
    }
    if (body?.system) body.system = splitSystemPrompt(body.system);
    if (!Array.isArray(body?.messages)) return body;
    let cacheControl = null;
    const kept = [];
    for (const msg of body.messages) {
        if (msg?.role === 'system') {
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            cacheControl = blocks.findLast(b => b?.cache_control)?.cache_control ?? cacheControl;
            continue;
        }
        if (msg?.role === 'user' && Array.isArray(msg.content)) {
            msg.content = msg.content.filter(b => {
                const drop = b?.type === 'text' && REMINDER.test(b.text ?? '');
                if (drop && b.cache_control) cacheControl = b.cache_control;
                return !drop;
            });
            if (msg.content.length === 0) continue;
            kept.push(...splitSystemNotes(msg, midSystem));
            continue;
        }
        kept.push(msg);
    }
    body.messages = kept;
    const last = kept.at(-1)?.content;
    if (cacheControl && Array.isArray(last) && last.length > 0 && !last.some(b => b?.cache_control)) {
        last[last.length - 1].cache_control = cacheControl;
    }
    return body;
}

/**
 * Rewrites Messages request bodies so everything else stays untouched.
 * @param {() => { stripSdkIdentity?: boolean }} getConfig
 * @returns {Promise<http.Server>}
 */
export async function startUpstreamProxy(getConfig) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => forward(req, res, Buffer.concat(chunks), { sdkIdentity: Boolean(getConfig().stripSdkIdentity) }));
        req.on('error', () => res.destroy());
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
    server.on('close', () => { baseUrl = null; });
    return server;
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function forward(req, res, body, options) {
    const headers = { ...req.headers };
    delete headers.host;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && pathname === '/v1/messages') {
        countHeaders = pickCountHeaders(headers);
    }
    let fallback = null;
    if (req.method === 'POST' && pathname === '/v1/messages' && !headers['content-encoding']) {
        try {
            const raw = body.toString('utf8');
            const parsed = JSON.parse(raw);
            const stripped = stripHostContext(parsed, { ...options, midSystem: supportsMidSystem(parsed?.model) });
            body = Buffer.from(JSON.stringify(stripped));
            headers['content-length'] = String(body.length);
            if (stripped.messages?.some(m => m?.role === 'system')) {
                fallback = Buffer.from(JSON.stringify(stripHostContext(JSON.parse(raw), { ...options, midSystem: false })));
            }
        } catch {
        }
    }
    send(body, fallback);

    function send(payload, retry) {
        const upstream = https.request({ host: UPSTREAM_HOST, path: req.url, method: req.method, headers }, upRes => {
            if (upRes.statusCode !== 400 || !retry) {
                res.writeHead(upRes.statusCode ?? 502, upRes.headers);
                upRes.pipe(res);
                return;
            }
            const chunks = [];
            upRes.on('data', chunk => chunks.push(chunk));
            upRes.on('end', () => {
                const raw = Buffer.concat(chunks);
                if (ROLE_UNSUPPORTED.test(decode(raw, upRes.headers['content-encoding']))) {
                    warn('This model does not take mid-chat system messages, so they were sent as user text.');
                    headers['content-length'] = String(retry.length);
                    send(retry, null);
                    return;
                }
                res.writeHead(400, upRes.headers);
                res.end(raw);
            });
            upRes.on('error', () => res.destroy());
        });
        upstream.on('error', error => {
            if (res.headersSent) return res.destroy();
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `claude-bridge upstream: ${error.message}` } }));
        });
        res.on('close', () => upstream.destroy());
        upstream.end(payload);
    }
}

function decode(raw, encoding) {
    try {
        if (encoding === 'gzip') return zlib.gunzipSync(raw).toString('utf8');
        if (encoding === 'br') return zlib.brotliDecompressSync(raw).toString('utf8');
        if (encoding === 'deflate') return zlib.inflateSync(raw).toString('utf8');
        if (encoding === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(raw).toString('utf8');
        return raw.toString('utf8');
    } catch {
        return '';
    }
}

/** @param {http.IncomingHttpHeaders} headers */
function pickCountHeaders(headers) {
    const picked = { 'content-type': 'application/json' };
    for (const key of ['authorization', 'x-api-key', 'anthropic-version', 'user-agent', 'x-app']) {
        if (headers[key]) picked[key] = String(headers[key]);
    }
    const oauth = String(headers['anthropic-beta'] ?? '').split(',').map(b => b.trim()).filter(b => b.startsWith('oauth-'));
    picked['anthropic-beta'] = [...oauth, 'token-counting-2024-11-01'].join(',');
    return picked;
}

function countRequest(model, text) {
    const body = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: text }] }));
    return new Promise((resolve, reject) => {
        const req = https.request({
            host: UPSTREAM_HOST,
            path: '/v1/messages/count_tokens?beta=true',
            method: 'POST',
            headers: { ...countHeaders, 'content-length': String(body.length) },
            timeout: 10_000,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (res.statusCode === 200 && Number.isInteger(json.input_tokens)) resolve(json.input_tokens);
                    else reject(new Error(json?.error?.message ?? `count_tokens returned ${res.statusCode}`));
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('count_tokens timed out')));
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * Counts `text` with Anthropic's tokenizer using the CLI's own login.
 */
export async function countTokens(model, text) {
    if (!countHeaders || !text) return null;
    model = model.replace(/\[1m\]$/i, '');
    if (!countOverhead.has(model)) {
        const overhead = countRequest(model, 'a').then(n => n - 1);
        overhead.catch(() => countOverhead.delete(model));
        countOverhead.set(model, overhead);
    }
    const [total, overhead] = await Promise.all([countRequest(model, text), countOverhead.get(model)]);
    return Math.max(0, total - overhead);
}
