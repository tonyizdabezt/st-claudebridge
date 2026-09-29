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

/** @returns {{ sdkVersion: string, cliVersion: string }} */
export function sdkVersions() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve(PACKAGE)), 'package.json'), 'utf8'));
        return { sdkVersion: pkg.version, cliVersion: pkg.claudeCodeVersion ?? '' };
    } catch {
        return { sdkVersion: '', cliVersion: '' };
    }
}

/**
 * Subprocess environment.
 * @param {number} [maxTokens]
 */
export function buildEnv(maxTokens) {
    const env = { ...process.env };
    for (const key of STRIPPED_ENV) delete env[key];
    const proxy = upstreamUrl();
    if (proxy) env.ANTHROPIC_BASE_URL = proxy;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'claudebridge/1.0.0';
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (Number.isInteger(maxTokens) && maxTokens > 0) {
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    }
    return env;
}

/**
 * Options that strip Claude Code down to a plain chat model.
 * @param {string} cwd
 */
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
        // skips CLI's title generation request on new sessions
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

/**
 * Account, model list and plan quota, read through the CLI.
 * @param {string} cwd
 * @param {boolean} [force]
 */
export function probe(cwd, force = false) {
    if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
        return Promise.resolve(probeCache.value);
    }
    probeInflight ??= runProbe(cwd).finally(() => { probeInflight = null; });
    return probeInflight;
}

/** @param {string} cwd */
async function runProbe(cwd) {
    const { query } = await loadSdk();
    const q = query({ prompt: idlePrompt(), options: { ...isolationOptions(cwd), persistSession: false, env: buildEnv() } });
    try {
        const account = await q.accountInfo();
        const models = await q.supportedModels();
        let quota = null;
        try {
            // Experimental API; the quota meter is optional.
            const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
            if (usage.rate_limits_available && usage.rate_limits) {
                quota = {
                    fiveHour: usage.rate_limits.five_hour ?? null,
                    sevenDay: usage.rate_limits.seven_day ?? null,
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

export function cachedModels() {
    return probeCache?.value.models ?? null;
}
