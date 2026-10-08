import crypto from 'node:crypto';
import { buildSessionEntries, oneShotStore, foldIntoPrompt } from './session.js';
import { StopScanner } from './filters.js';
import { loadSdk, buildEnv, isolationOptions, cachedModels, sdkVersions, bundledCliPath, updateQuota } from './sdk.js';
import { HttpError } from './errors.js';
import { pushNotice, warn } from './notices.js';
import { Meter } from './usage.js';
import { checkSystemPlacement } from './convert.js';

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
 * @property {'auto' | '5m' | '1h'} cacheTtl
 * @property {number} idleTimeoutMs
 * @property {boolean} refuseModelSwap
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
const ALWAYS_THINKS = /fable|mythos|opus-5-5|sonnet-5-5/;
const ADAPTIVE_CAPABLE = /opus-4-[678]|sonnet-4-6|opus-5|sonnet-5|haiku-5|fable|mythos/;
const BUDGET_ALLOWED = /opus-4-6|sonnet-4-6/;
const THINKS_BY_DEFAULT = /opus-5|sonnet-5|haiku-5|fable|mythos/;

function resolveModel(requested) {
    const model = typeof requested === 'string' && requested && requested !== 'default' ? requested : undefined;
    const base = (model ?? 'default').replace(/\[1m\]$/i, '');
    const info = cachedModels()?.find(m => m.value === base || m.resolvedModel === base);
    return { model, info, id: info?.resolvedModel ?? base };
}

/**
 * Compares a requested and a served model id.
 */
export function sameModel(requested, served) {
    if (!String(requested ?? '').startsWith('claude-') || !String(served ?? '').startsWith('claude-')) return true;
    const base = m => m.toLowerCase().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
    return base(requested) === base(served);
}

/**
 * Picks a thinking config the model accepts.
 * @param {Pick<ChatRequest, 'thinking' | 'thinkingBudget' | 'showReasoning' | 'maxTokens'>} req
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
 * @param {object} thinking Resolved thinking config
 */
export function effortFor(id, info, effort, thinking) {
    if (!effort) return undefined;
    const levels = info ? info.supportedEffortLevels ?? [] : (ADAPTIVE_CAPABLE.test(id) ? ['low', 'medium', 'high', 'xhigh', 'max'] : []);
    if (!levels.includes(effort)) return undefined;
    if (thinking.type === 'disabled' && /opus-5|haiku-5/.test(id) && (effort === 'xhigh' || effort === 'max')) return 'high';
    return effort;
}

function userMessage(content) {
    return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

async function* single(message) {
    yield message;
}

function formatReset(resetsAt) {
    if (!resetsAt) return '';
    const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
    return ` Resets at ${new Date(ms).toLocaleString()}.`;
}

const LIMIT_NAMES = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' };
const warnedLimits = new Set();

/**
 * Refreshes the cached quota and warns once per window near a limit or when usage credits pay.
 * @param {import('@anthropic-ai/claude-agent-sdk').SDKRateLimitInfo & { unifiedWindows?: any }} info
 */
function noteRateLimit(info) {
    updateQuota(info.unifiedWindows);
    const once = (key, message) => {
        if (warnedLimits.has(key)) return;
        warnedLimits.add(key);
        warn(message);
    };
    if (info.status === 'allowed_warning') {
        const used = info.unifiedWindows?.[info.rateLimitType]?.utilization ?? info.utilization;
        const amount = used == null ? 'most' : `${Math.round(used <= 1 ? used * 100 : used)}%`;
        once(`${info.rateLimitType}:${info.resetsAt}`, `You've used ${amount} of your ${LIMIT_NAMES[info.rateLimitType] ?? 'plan'} limit.${formatReset(info.resetsAt)}`);
    }
    if (info.isUsingOverage) {
        once(`overage:${info.resetsAt}`, `Your plan limit is used up, so replies are now paid from your usage credits.${formatReset(info.resetsAt)}`);
    }
}

/** @param {string | undefined} code SDKAssistantMessageError */
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

/** @param {{ api_refusal_category?: string | null, api_refusal_explanation?: string | null }} refusal */
function refusalError(model, refusal) {
    const reason = refusal.api_refusal_explanation?.trim()
        || (refusal.api_refusal_category ? `Category: ${refusal.api_refusal_category}.` : '');
    return new HttpError(400, [`Safeguards on ${model} flagged this message and stopped the reply.`, reason, 'Edit the message or switch models, then retry.'].filter(Boolean).join(' '));
}

/**
 * Runs one chat turn through the Agent SDK.
 * @param {object} params
 * @param {ChatRequest} params.req
 * @param {{ text: (t: string) => void, reasoning: (t: string) => void }} params.sink
 * @param {(entry: object, text: string) => void} [params.onUsage] Called once with the request's usage and streamed text, success or not
 * @returns {Promise<ChatResult>}
 */
export async function runChat({ req, cwd, abortController, sink, onUsage }) {
    const { system, history, current } = req.conversation;
    const { model, info, id } = resolveModel(req.model);
    checkSystemPlacement(req.conversation, id);
    const thinking = thinkingConfig(id, req);
    const effort = effortFor(id, info, req.effort, thinking);

    const baseOptions = {
        ...isolationOptions(cwd),
        model,
        systemPrompt: system,
        thinking,
        ...(effort ? { effort } : {}),
        includePartialMessages: true,
        abortController,
        env: buildEnv(req.maxTokens, req.cacheTtl),
    };

    const meter = new Meter(model ?? id);
    try {
        const result = await withFallback();
        onUsage?.(meter.entry(), meter.text);
        return result;
    } catch (error) {
        onUsage?.(meter.entry(error.status ?? 500), meter.text);
        throw error;
    }

    async function withFallback() {
        const useResume = history.length > 0;
        try {
            return await attempt(useResume);
        } catch (error) {
            if (useResume && !error.emitted && /no conversation found/i.test(error.message)) {
                console.warn('[claude-bridge] Resume failed, retrying with folded transcript:', error.message);
                pushNotice('Claude Code could not load the chat history as real turns so it was sent as one folded message instead. Replies may be less consistent.');
                meter.reset();
                return await attempt(false);
            }
            throw error;
        }
    }

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
        let refusal = null;
        let replies = 0;
        let idle = false;
        let idleTimer;

        const emitText = (text) => {
            meter.token(text);
            const out = stops.push(text);
            if (out) {
                emitted = true;
                sink.text(out);
            }
        };

        const checkServed = (served, afterRefusal) => {
            if (!req.refuseModelSwap || sameModel(id, served)) return;
            const message = afterRefusal
                ? `Safeguards on ${id} stopped the reply and Claude Code tried to answer with ${served} instead.`
                : `You picked ${id} but Claude Code is serving ${served}, which can happen when a model is unavailable on your plan.`;
            throw Object.assign(new HttpError(409, message), { emitted });
        };
        const idleError = () => Object.assign(new HttpError(504, `Claude Code sent nothing for ${req.idleTimeoutMs / 1000} seconds, so the request was stopped. Try again.`), { emitted });

        const q = query({ prompt, options });
        const armIdle = () => {
            if (!req.idleTimeoutMs) return;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { idle = true; q.close(); }, req.idleTimeoutMs);
        };
        armIdle();
        try {
            for await (const message of q) {
                armIdle();
                if (abortController.signal.aborted) break;
                if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
                    const event = message.event;
                    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                        emitText(event.delta.text);
                        if (stops.stopped) break;
                    } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' && req.showReasoning) {
                        emitted = true;
                        meter.token(event.delta.thinking, false);
                        sink.reasoning(event.delta.thinking);
                    } else if (event.type === 'content_block_start') {
                        meter.thinking(event.content_block.type.endsWith('thinking'));
                    } else if (event.type === 'content_block_stop') {
                        meter.thinking(false);
                    } else if (event.type === 'message_start') {
                        checkServed(event.message.model, ++replies > 1);
                        usage = meter.usage = { ...event.message.usage };
                    } else if (event.type === 'message_delta') {
                        usage = meter.usage = { ...usage, ...event.usage };
                        if (event.delta.stop_reason === 'max_tokens') stopReason = 'max_tokens';
                    }
                } else if (message.type === 'system' && message.subtype === 'init') {
                    servedModel = meter.model = message.model;
                    checkServed(message.model, false);
                    if (!sameModel(id, message.model)) {
                        warn(`You picked ${id} but Claude Code is answering with ${message.model}.`);
                    }
                } else if (message.type === 'system' && message.subtype === 'model_refusal_fallback' && message.scope !== 'local') {
                    checkServed(message.fallback_model, true);
                    warn(`Safeguards on ${message.original_model} refused the reply, so Claude Code is answering with ${message.fallback_model} instead.`);
                } else if (message.type === 'system' && message.subtype === 'model_refusal_no_fallback') {
                    refusal = message;
                } else if (message.type === 'assistant' && message.error) {
                    errorCode = message.error;
                } else if (message.type === 'rate_limit_event') {
                    rateLimit = message.rate_limit_info;
                    noteRateLimit(rateLimit);
                } else if (message.type === 'result') {
                    usage = meter.usage = message.usage;
                    meter.modelUsage = message.modelUsage;
                    meter.cost = message.total_cost_usd;
                    if (message.stop_reason === 'refusal') refusal ??= {};
                    if (message.is_error && refusal) {
                        throw Object.assign(refusalError(refusal.original_model ?? servedModel, refusal), { emitted });
                    }
                    if (message.is_error) {
                        const detail = 'result' in message ? message.result : (message.errors ?? []).join('; ');
                        throw Object.assign(classifyError(errorCode, message.api_error_status, detail, rateLimit), { emitted });
                    }
                }
            }
        } catch (error) {
            if (error instanceof HttpError) throw error;
            if (abortController.signal.aborted) throw Object.assign(new HttpError(499, 'Request aborted'), { emitted });
            if (idle) throw idleError();
            const detail = [error.message, stderr.join('').trim().split('\n').slice(-3).join(' ')].filter(Boolean).join(' | ');
            throw Object.assign(classifyError(errorCode, null, detail, rateLimit), { emitted });
        } finally {
            clearTimeout(idleTimer);
            q.close();
        }
        if (abortController.signal.aborted) {
            throw Object.assign(new HttpError(499, 'Request aborted'), { emitted });
        }
        if (idle) throw idleError();

        const tail = stops.flush();
        if (tail) sink.text(tail);
        if (stops.stopped) stopReason = 'stop_sequence';
        return { model: servedModel, stopReason, stopSequence: stops.matched, usage };
    }
}
