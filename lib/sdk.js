import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { upstreamUrl } from './upstream.js';

const require = createRequire(import.meta.url);
const PACKAGE = '@anthropic-ai/claude-agent-sdk';
const PROBE_TTL_MS = 30_000;

const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'];

let sdkPromise = null;
/** @returns {Promise<typeof import('@anthropic-ai/claude-agent-sdk')>} */
export function loadSdk() {
    sdkPromise ??= import(PACKAGE);
    return sdkPromise;
}

export function sdkVersions() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve(PACKAGE)), 'package.json'), 'utf8'));
        return { sdkVersion: pkg.version, cliVersion: pkg.claudeCodeVersion ?? '' };
    } catch {
        return { sdkVersion: '', cliVersion: '' };
    }
}

/** Subprocess environment. */
export function buildEnv(maxTokens, cacheTtl) {
    const env = { ...process.env };
    for (const key of STRIPPED_ENV) delete env[key];
    const proxy = upstreamUrl();
    if (proxy) env.ANTHROPIC_BASE_URL = proxy;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'claudebridge/1.2.0';
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (cacheTtl === '5m' || cacheTtl === '1h') {
        // FORCE_PROMPT_CACHING_5M would override the chosen TTL.
        delete env.FORCE_PROMPT_CACHING_5M;
        env.CLAUDE_CODE_PROMPT_CACHE_TTL = cacheTtl;
    }
    if (Number.isInteger(maxTokens) && maxTokens > 0) {
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    }
    return env;
}

/** Options that strip Claude Code down to a plain chat model. */
export function isolationOptions(cwd) {
    return {
        cwd,
        tools: [],
        skills: [],
        settingSources: [],
        strictMcpConfig: true,
        verbatimPrompts: true,
        permissionMode: 'dontAsk',
        maxTurns: 1,
        title: 'ClaudeBridge',
    };
}

async function* idlePrompt() {
    await new Promise(() => {});
}

export function bundledCliPath() {
    try {
        const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
        return require.resolve(`${PACKAGE}-${process.platform}-${process.arch}/${exe}`);
    } catch {
        return 'claude';
    }
}

let probeCache = null;
let probeInflight = null;

/** Account, model list and plan quota, read through the CLI. */
export function probe(cwd, force = false) {
    if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
        return Promise.resolve(probeCache.value);
    }
    probeInflight ??= runProbe(cwd).finally(() => { probeInflight = null; });
    return probeInflight;
}

async function runProbe(cwd) {
    const { query } = await loadSdk();
    const env = buildEnv();
    // The CLI skips the quota request when this flag is set.
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    const q = query({ prompt: idlePrompt(), options: { ...isolationOptions(cwd), persistSession: false, env } });
    try {
        const account = await q.accountInfo();
        const models = await q.supportedModels();
        let quota = null;
        try {
            const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
            if (usage.rate_limits_available && usage.rate_limits) {
                quota = {
                    fiveHour: usage.rate_limits.five_hour ?? null,
                    sevenDay: usage.rate_limits.seven_day ?? null,
                    modelScoped: (usage.rate_limits.model_scoped ?? [])
                        .filter(w => !(usage.subscription_type === 'pro' && /fable/i.test(w.display_name))),
                };
            }
        } catch (error) {
            console.debug('[claude-bridge] Quota unavailable:', error.message);
        }
        const value = {
            loggedIn: account.apiProvider === 'firstParty' ? Boolean(account.subscriptionType) : false,
            subscription: account.subscriptionType ?? null,
            apiProvider: account.apiProvider ?? null,
            usingApiKey: Boolean(account.apiKeySource),
            models,
            quota,
        };
        probeCache = { at: Date.now(), value };
        return value;
    } finally {
        q.close();
    }
}

export function cachedQuota() {
    return probeCache?.value.quota ?? null;
}

/**
 * Applies a rate_limit_event's windows to the cached quota.
 * @param {Record<string, { utilization: number, resetsAt: number }> | undefined} windows Fractions and epoch seconds
 */
export function updateQuota(windows) {
    const quota = probeCache?.value.quota;
    if (!quota || !windows) return;
    const toWindow = w => ({ utilization: w.utilization * 100, resets_at: new Date(w.resetsAt * 1000).toISOString() });
    if (windows.five_hour) quota.fiveHour = toWindow(windows.five_hour);
    if (windows.seven_day) quota.sevenDay = toWindow(windows.seven_day);
}

export function cachedModels() {
    return probeCache?.value.models ?? null;
}
