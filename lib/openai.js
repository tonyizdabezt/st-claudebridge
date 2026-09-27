import crypto from 'node:crypto';
import { fromOpenAi } from './convert.js';
import { EFFORT_LEVELS, sanitizeEditable } from './config.js';

/**
 * OpenAI chat-completions adapter.
 * @param {any} body
 * @param {object} defaults
 * @returns {import('./chat.js').ChatRequest}
 */
export function parseOpenAi(body, defaults) {
    const s = { ...defaults, ...sanitizeEditable(body?.claude_bridge) };
    if (!body?.claude_bridge?.effort && EFFORT_LEVELS.includes(body?.reasoning_effort)) {
        s.effort = body.reasoning_effort;
    }
    const stop = body?.stop;
    return {
        conversation: fromOpenAi(body?.messages),
        model: body?.model,
        stops: Array.isArray(stop) ? stop : (typeof stop === 'string' ? [stop] : []),
        maxTokens: Number.isInteger(body?.max_tokens) && body.max_tokens > 0 ? body.max_tokens : undefined,
        thinking: s.thinking,
        thinkingBudget: s.thinkingBudget,
        showReasoning: s.showReasoning,
        effort: s.effort,
        resume: s.resume,
    };
}

/** @param {any} usage SDK result usage */
export function toOpenAiUsage(usage) {
    if (!usage) return undefined;
    const cached = usage.cache_read_input_tokens ?? 0;
    const prompt = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0);
    const completion = usage.output_tokens ?? 0;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: cached },
    };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {any} body
 */
export function openAiWriter(res, body) {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = Boolean(body?.stream);
    let text = '';
    let reasoning = '';

    const chunk = (delta, finishReason = null, extra = {}) => ({
        id, object: 'chat.completion.chunk', created, model: body?.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra,
    });
    const write = (payload) => {
        if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        }
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    return {
        sink: stream
            ? { text: t => write(chunk({ content: t })), reasoning: t => write(chunk({ reasoning_content: t })) }
            : { text: t => { text += t; }, reasoning: t => { reasoning += t; } },

        /** @param {import('./chat.js').ChatResult} result */
        finish(result) {
            const finishReason = result.stopReason === 'max_tokens' ? 'length' : 'stop';
            const usage = toOpenAiUsage(result.usage);
            if (stream) {
                write(chunk({}, finishReason, { model: result.model, usage }));
                res.end('data: [DONE]\n\n');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id, object: 'chat.completion', created, model: result.model,
                choices: [{ index: 0, message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finishReason }],
                usage,
            }));
        },

        /** @param {{ status?: number, message: string }} error */
        fail(error) {
            const status = error.status ?? 500;
            if (res.headersSent) {
                write({ error: { message: error.message, code: status } });
                res.end('data: [DONE]\n\n');
                return;
            }
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message, type: 'claude_bridge_error', code: status } }));
        },
    };
}
