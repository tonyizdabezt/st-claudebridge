import http from 'node:http';
import crypto from 'node:crypto';
import { runChat, HttpError } from './chat.js';
import { probe } from './sdk.js';
import { parseOpenAi, openAiWriter } from './openai.js';
import { parseAnthropic, anthropicWriter } from './anthropic.js';

const MAX_BODY_BYTES = 100 * 1024 * 1024;

// Models whose 1M context is opt-in via a `[1m]` variant.
const OPT_IN_1M = /^claude-(opus|sonnet)-4-6$/;

const ROUTES = {
    '/v1/chat/completions': { parse: parseOpenAi, writer: openAiWriter },
    '/v1/messages': { parse: parseAnthropic, writer: anthropicWriter },
};

/**
 * Accepts the secret as `Authorization: Bearer` or `x-api-key`.
 * @param {http.IncomingHttpHeaders} headers
 * @param {string} secret
 */
function authorized(headers, secret) {
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
    const key = String(headers['x-api-key'] ?? '');
    const expected = Buffer.from(secret);
    return [bearer, key].some(token => {
        const actual = Buffer.from(token ?? '');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    });
}

/** @param {http.IncomingMessage} req */
function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new HttpError(413, 'Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new HttpError(400, 'Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} payload
 */
function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * Model list readable by both OpenAI and Anthropic clients.
 * @param {any[]} models
 */
function modelList(models) {
    const data = [];
    const seen = new Set();
    const add = (id, name) => {
        if (seen.has(id)) return;
        seen.add(id);
        data.push({ id, object: 'model', type: 'model', owned_by: 'anthropic', display_name: name, name, created_at: '1970-01-01T00:00:00Z' });
    };
    for (const m of models) {
        add(m.value, m.displayName);
        const resolved = m.resolvedModel ?? m.value;
        if (OPT_IN_1M.test(resolved)) add(`${resolved}[1m]`, `${m.displayName} (1M context)`);
    }
    return { object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

/**
 * @param {object} ctx
 * @param {() => object} ctx.getConfig
 * @param {string} ctx.cwd
 * @param {Set<AbortController>} ctx.active
 */
export function createServer(ctx) {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = ROUTES[url.pathname];
        try {
            const config = ctx.getConfig();
            if (!authorized(req.headers, config.secret)) {
                throw new HttpError(401, 'Missing or invalid API key. Use the ClaudeBridge panel to connect.');
            }
            if (req.method === 'GET' && url.pathname === '/v1/models') {
                const { models } = await probe(ctx.cwd);
                return sendJson(res, 200, modelList(models));
            }
            if (req.method === 'POST' && route) {
                return await handleChat(req, res, ctx, config, route);
            }
            if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
                throw new HttpError(501, 'Embeddings are not available through a Claude subscription.');
            }
            throw new HttpError(404, 'Not found');
        } catch (error) {
            if (res.headersSent) return;
            (route ?? ROUTES['/v1/chat/completions']).writer(res, {}).fail(error);
        }
    });
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {{ cwd: string, active: Set<AbortController> }} ctx
 * @param {object} config
 * @param {{ parse: Function, writer: Function }} route
 */
async function handleChat(req, res, ctx, config, route) {
    const body = await readJson(req);
    const chatReq = route.parse(body, config);
    const writer = route.writer(res, body);
    const abortController = new AbortController();
    ctx.active.add(abortController);
    res.on('close', () => {
        if (!res.writableFinished) abortController.abort();
    });

    try {
        const result = await runChat({ req: chatReq, cwd: ctx.cwd, abortController, sink: writer.sink });
        writer.finish(result);
    } catch (error) {
        if (abortController.signal.aborted || res.destroyed) return;
        console.error('[claude-bridge]', error.message);
        writer.fail(error);
    } finally {
        ctx.active.delete(abortController);
    }
}
