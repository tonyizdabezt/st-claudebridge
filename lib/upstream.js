import http from 'node:http';
import https from 'node:https';

const UPSTREAM_HOST = 'api.anthropic.com';
const REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;
const SDK_IDENTITY = /^\s*You are a Claude agent, built on Anthropic's Claude Agent SDK\.\s*$/;

/** @type {string | null} */
let baseUrl = null;

export function upstreamUrl() {
    return baseUrl;
}

/**
 * Removes the host context Claude Code adds: `<system-reminder>` blocks on user
 * messages and `system`-role messages (environment, model identity, date).
 * @param {any} body Messages API request body
 * @param {{ sdkIdentity?: boolean }} [options]
 */
export function stripHostContext(body, { sdkIdentity = false } = {}) {
    if (sdkIdentity && Array.isArray(body?.system)) {
        body.system = body.system.filter(b => !(b?.type === 'text' && SDK_IDENTITY.test(b.text ?? '')));
    }
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
 * @param {Buffer} body
 * @param {{ sdkIdentity: boolean }} options
 */
function forward(req, res, body, options) {
    const headers = { ...req.headers };
    delete headers.host;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && pathname === '/v1/messages' && !headers['content-encoding']) {
        try {
            body = Buffer.from(JSON.stringify(stripHostContext(JSON.parse(body.toString('utf8')), options)));
            headers['content-length'] = String(body.length);
        } catch {
        }
    }

    const upstream = https.request({ host: UPSTREAM_HOST, path: req.url, method: req.method, headers }, upRes => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
    });
    upstream.on('error', error => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `claude-bridge upstream: ${error.message}` } }));
    });
    res.on('close', () => upstream.destroy());
    upstream.end(body);
}
