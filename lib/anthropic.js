import crypto from 'node:crypto';
import { fromAnthropic } from './convert.js';
import { HttpError } from './chat.js';

const ERROR_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error' };

/**
 * Anthropic Messages adapter (SillyTavern's Claude source).
 * @param {object} defaults Plugin config
 * @returns {import('./chat.js').ChatRequest}
 */
export function parseAnthropic(body, defaults) {
    const choice = body?.tool_choice?.type;
    if (choice === 'tool' || choice === 'any' || body?.output_config?.format) {
        throw new HttpError(400, 'Tool calls and structured JSON output are not available through ClaudeBridge.');
    }
    if (Array.isArray(body?.tools) && body.tools.length > 0) {
        console.warn('[claude-bridge] Ignoring tools in request; ClaudeBridge runs without tools.');
    }

    const t = body?.thinking;
    const thinking = !t ? 'default' : t.type === 'enabled' ? 'enabled' : t.type === 'disabled' ? 'disabled' : 'adaptive';
    return {
        conversation: fromAnthropic(body),
        model: typeof body?.model === 'string' ? body.model.replace(/\[1m\]$/i, '') : undefined,
        stops: Array.isArray(body?.stop_sequences) ? body.stop_sequences : [],
        maxTokens: Number.isInteger(body?.max_tokens) && body.max_tokens > 0 ? body.max_tokens : undefined,
        thinking,
        thinkingBudget: Number.isInteger(t?.budget_tokens) ? t.budget_tokens : defaults.thinkingBudget,
        showReasoning: t?.display !== 'omitted',
        effort: body?.output_config?.effort ?? defaults.effort,
        idleTimeoutMs: defaults.idleTimeoutSeconds * 1000,
        refuseModelSwap: defaults.refuseModelSwap,
    };
}

function toAnthropicUsage(usage) {
    return {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    };
}

/** @param {import('node:http').ServerResponse} res */
export function anthropicWriter(res, body) {
    const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const stream = Boolean(body?.stream);
    let text = '';
    let reasoning = '';
    let started = false;
    let index = -1;
    /** @type {'text' | 'thinking' | null} */
    let open = null;

    const send = (event, data) => {
        if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        }
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const start = () => {
        if (started) return;
        started = true;
        send('message_start', {
            type: 'message_start',
            message: { id, type: 'message', role: 'assistant', model: body?.model, content: [], stop_reason: null, stop_sequence: null, usage: toAnthropicUsage(null) },
        });
    };
    const closeBlock = () => {
        if (open) send('content_block_stop', { type: 'content_block_stop', index });
        open = null;
    };
    /** @param {'text' | 'thinking'} type */
    const delta = (type, chunk) => {
        start();
        if (open !== type) {
            closeBlock();
            index++;
            open = type;
            const block = type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' };
            send('content_block_start', { type: 'content_block_start', index, content_block: block });
        }
        const d = type === 'text' ? { type: 'text_delta', text: chunk } : { type: 'thinking_delta', thinking: chunk };
        send('content_block_delta', { type: 'content_block_delta', index, delta: d });
    };

    return {
        sink: stream
            ? { text: t => delta('text', t), reasoning: t => delta('thinking', t) }
            : { text: t => { text += t; }, reasoning: t => { reasoning += t; } },

        /** @param {import('./chat.js').ChatResult} result */
        finish(result) {
            const usage = toAnthropicUsage(result.usage);
            if (stream) {
                start();
                closeBlock();
                send('message_delta', { type: 'message_delta', delta: { stop_reason: result.stopReason, stop_sequence: result.stopSequence }, usage });
                send('message_stop', { type: 'message_stop' });
                res.end();
                return;
            }
            const content = [{ type: 'text', text }];
            if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id, type: 'message', role: 'assistant', model: result.model, content,
                stop_reason: result.stopReason, stop_sequence: result.stopSequence, usage,
            }));
        },

        /** @param {{ status?: number, message: string }} error */
        fail(error) {
            const status = error.status ?? 500;
            const payload = { type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message: error.message } };
            if (res.headersSent) {
                send('error', payload);
                res.end();
                return;
            }
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        },
    };
}
