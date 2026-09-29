import crypto from 'node:crypto';
import { buildSessionEntries, oneShotStore, foldIntoPrompt } from './session.js';
import { StopScanner } from './filters.js';
import { loadSdk, buildEnv, isolationOptions, cachedModels, sdkVersions, bundledCliPath } from './sdk.js';
import { HttpError } from './errors.js';

export { HttpError };

/**
 * Format-neutral chat request, built by the OpenAI and Anthropic adapters.
 * @typedef {object} ChatRequest
 * @property {import('./convert.js').Conversation} conversation
 * @property {string | undefined} model
 * @property {string[]} stops
 * @property {number | undefined} maxTokens
 * @property {'adaptive' | 'enabled' | 'disabled' | 'default'} thinking
 * @property {number} thinkingBudget
 * @property {boolean} showReasoning
 * @property {string | undefined} effort
 */

/**
 * @typedef {object} ChatResult
 * @property {string} model
 * @property {'end_turn' | 'max_tokens' | 'stop_sequence'} stopReason
 * @property {string | null} stopSequence
 * @property {any} usage
 */

const { cliVersion } = sdkVersions();

// Thinking rules per model family
const ALWAYS_THINKS = /fable|mythos|opus-5-5/;
const ADAPTIVE_CAPABLE = /opus-4-[678]|sonnet-4-6|opus-5|sonnet-5|fable|mythos/;
const BUDGET_ALLOWED = /opus-4-6|sonnet-4-6/;
const THINKS_BY_DEFAULT = /opus-5|sonnet-5|fable|mythos/;

// Deprecated models, mapped to their closest successor.
const REROUTES = {
    'claude-sonnet-4-0': 'claude-sonnet-4-5',
    'claude-sonnet-4-20250514': 'claude-sonnet-4-5',
};

/** @param {string | undefined} requested */
function resolveModel(requested) {
    let model = typeof requested === 'string' && requested && requested !== 'default' ? requested : undefined;
    if (model && REROUTES[model]) {
        console.info(`[claude-bridge] ${model} is not served on subscriptions; using ${REROUTES[model]}`);
        model = REROUTES[model];
    }
    const base = (model ?? 'default').replace(/\[1m\]$/i, '');
    const info = cachedModels()?.find(m => m.value === base || m.resolvedModel === base);
    return { model, info, id: info?.resolvedModel ?? base };
}

/**
 * Picks a thinking config the model accepts.
 * @param {string} id
 * @param {Pick<ChatRequest, 'thinking' | 'thinkingBudget' | 'showReasoning' | 'maxTokens'>} req
 * @returns {object}
 */
export function thinkingConfig(id, req) {
    const display = req.showReasoning ? 'summarized' : 'omitted';
    const adaptiveCapable = ADAPTIVE_CAPABLE.test(id) || id === 'default';
    const adaptive = { type: 'adaptive', display };

    let mode = req.thinking;
    if (mode === 'default') {
        mode = THINKS_BY_DEFAULT.test(id) || id === 'default' ? 'adaptive' : 'disabled';
    }
    if (mode === 'disabled') {
        return ALWAYS_THINKS.test(id) ? adaptive : { type: 'disabled' };
    }
    if (mode === 'adaptive' && adaptiveCapable) {
        return adaptive;
    }
    if (adaptiveCapable && !BUDGET_ALLOWED.test(id)) {
        return adaptive;
    }
    let budget = req.thinkingBudget;
    if (req.maxTokens) budget = Math.min(budget, req.maxTokens - 512);
    if (budget < 1024) {
        return ALWAYS_THINKS.test(id) ? adaptive : { type: 'disabled' };
    }
    return { type: 'enabled', budgetTokens: budget, display };
}

/**
 * @param {string} id Resolved model id
 * @param {any} info SDK model info
 * @param {string | undefined} effort
 * @param {object} thinking Resolved thinking config
 */
export function effortFor(id, info, effort, thinking) {
    if (!effort) return undefined;
    const levels = info ? info.supportedEffortLevels ?? [] : (ADAPTIVE_CAPABLE.test(id) ? ['low', 'medium', 'high', 'xhigh', 'max'] : []);
    if (!levels.includes(effort)) return undefined;
    if (thinking.type === 'disabled' && /opus-5/.test(id) && (effort === 'xhigh' || effort === 'max')) return 'high';
    return effort;
}

/** @param {any} content */
function userMessage(content) {
    return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

/** @param {any} message */
async function* single(message) {
    yield message;
}

/** @param {number | undefined} resetsAt */
function formatReset(resetsAt) {
    if (!resetsAt) return '';
    const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
    return ` Resets at ${new Date(ms).toLocaleString()}.`;
}

/**
 * @param {string | undefined} code SDKAssistantMessageError
 * @param {number | null | undefined} status
 * @param {string} detail
 * @param {any} rateLimit
 */
function classifyError(code, status, detail, rateLimit) {
    if (code === 'authentication_failed' || code === 'oauth_org_not_allowed' || status === 401) {
        return new HttpError(401, `Claude Code is not logged in or the login expired. Run "${bundledCliPath()}" in a terminal and use /login (or sign in through the Claude Code VS Code extension), then retry.`);
    }
    if (code === 'rate_limit' || status === 429 || rateLimit?.status === 'rejected') {
        return new HttpError(429, `Claude subscription usage limit reached.${formatReset(rateLimit?.resetsAt)} ${detail}`.trim());
    }
    if (code === 'model_not_found' || status === 404) {
        return new HttpError(404, `This model is not available through your Claude subscription. ${detail}`.trim());
    }
    return new HttpError(502, detail || `Claude request failed (${code ?? status ?? 'unknown error'})`);
}

/**
 * Runs one chat turn through the Agent SDK.
 * @param {object} params
 * @param {ChatRequest} params.req
 * @param {string} params.cwd
 * @param {AbortController} params.abortController
 * @param {{ text: (t: string) => void, reasoning: (t: string) => void }} params.sink
 * @returns {Promise<ChatResult>}
 */
export async function runChat({ req, cwd, abortController, sink }) {
    const { system, history, current } = req.conversation;
    const { model, info, id } = resolveModel(req.model);
    const thinking = thinkingConfig(id, req);
    const effort = effortFor(id, info, req.effort, thinking);

    const baseOptions = {
        ...isolationOptions(cwd),
        model,
        // Host metadata the CLI injects is stripped by the upstream proxy.
        systemPrompt: system,
        thinking,
        ...(effort ? { effort } : {}),
        includePartialMessages: true,
        abortController,
        env: buildEnv(req.maxTokens),
    };

    const useResume = history.length > 0;
    try {
        return await attempt(useResume);
    } catch (error) {
        if (useResume && !error.emitted && /no conversation found/i.test(error.message)) {
            console.warn('[claude-bridge] Resume failed, retrying with folded transcript:', error.message);
            return await attempt(false);
        }
        throw error;
    }

    /**
     * @param {boolean} resume
     * @returns {Promise<ChatResult>}
     */
    async function attempt(resume) {
        const { query } = await loadSdk();
        const options = { ...baseOptions };
        let prompt;
        if (resume) {
            const sessionId = crypto.randomUUID();
            const entries = buildSessionEntries(history, { sessionId, cwd, version: cliVersion, model: id });
            Object.assign(options, { resume: sessionId, sessionStore: oneShotStore(sessionId, entries) });
            prompt = single(userMessage(current));
        } else {
            options.persistSession = false;
            prompt = single(userMessage(foldIntoPrompt(history, current)));
        }

        const stderr = [];
        options.stderr = data => { stderr.push(data); if (stderr.length > 20) stderr.shift(); };

        const stops = new StopScanner(req.stops);
        let emitted = false;
        let servedModel = model ?? id;
        /** @type {ChatResult['stopReason']} */
        let stopReason = 'end_turn';
        let usage = null;
        let errorCode;
        let rateLimit = null;

        const emitText = (text) => {
            const out = stops.push(text);
            if (out) {
                emitted = true;
                sink.text(out);
            }
        };

        const q = query({ prompt, options });
        try {
            for await (const message of q) {
                if (abortController.signal.aborted) break;
                if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
                    const event = message.event;
                    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                        emitText(event.delta.text);
                        if (stops.stopped) break;
                    } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' && req.showReasoning) {
                        emitted = true;
                        sink.reasoning(event.delta.thinking);
                    } else if (event.type === 'message_start') {
                        usage = { ...event.message.usage };
                    } else if (event.type === 'message_delta') {
                        usage = { ...usage, ...event.usage };
                        if (event.delta.stop_reason === 'max_tokens') stopReason = 'max_tokens';
                    }
                } else if (message.type === 'system' && message.subtype === 'init') {
                    servedModel = message.model;
                    if (message.model.replace(/\[1m\]$/i, '') !== id && id !== 'default') {
                        console.warn(`[claude-bridge] Requested ${id} but Claude Code is serving ${message.model}`);
                    }
                } else if (message.type === 'assistant' && message.error) {
                    errorCode = message.error;
                } else if (message.type === 'rate_limit_event') {
                    rateLimit = message.rate_limit_info;
                } else if (message.type === 'result') {
                    usage = message.usage;
                    if (message.is_error) {
                        const detail = 'result' in message ? message.result : (message.errors ?? []).join('; ');
                        throw Object.assign(classifyError(errorCode, message.api_error_status, detail, rateLimit), { emitted });
                    }
                }
            }
        } catch (error) {
            if (error instanceof HttpError) throw error;
            if (abortController.signal.aborted) throw Object.assign(new HttpError(499, 'Request aborted'), { emitted });
            const detail = [error.message, stderr.join('').trim().split('\n').slice(-3).join(' ')].filter(Boolean).join(' | ');
            throw Object.assign(classifyError(errorCode, null, detail, rateLimit), { emitted });
        } finally {
            q.close();
        }
        if (abortController.signal.aborted) {
            throw Object.assign(new HttpError(499, 'Request aborted'), { emitted });
        }

        const tail = stops.flush();
        if (tail) sink.text(tail);
        if (stops.stopped) stopReason = 'stop_sequence';
        return { model: servedModel, stopReason, stopSequence: stops.matched, usage };
    }
}
