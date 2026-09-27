import http from 'node:http';
import https from 'node:https';

const UPSTREAM_HOST = 'api.anthropic.com';
const REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

/** @type {string | null} */
let baseUrl = null;

export function upstreamUrl() {
    return baseUrl;
}

/**
 * Removes the `<system-reminder>` blocks Claude Code adds to user messages
 * (environment, account email, model identity, date).
 * @param {any} body Messages API request body
 */
export function stripHostContext(body) {
    for (const msg of Array.isArray(body?.messages) ? body.messages : []) {
        if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter(b => !(b?.type === 'text' && REMINDER.test(b.text ?? '')));
    }
    return body;
}

/**
 * Rewrites Messages request bodies so everything else stays untouched.
 * @returns {Promise<http.Server>}
 */
export async function startUpstreamProxy() {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => forward(req, res, Buffer.concat(chunks)));
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
 */
function forward(req, res, body) {
    const headers = { ...req.headers };
    delete headers.host;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && pathname === '/v1/messages' && !headers['content-encoding']) {
        try {
            body = Buffer.from(JSON.stringify(stripHostContext(JSON.parse(body.toString('utf8')))));
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
