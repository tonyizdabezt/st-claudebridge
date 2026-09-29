import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './lib/config.js';
import { createServer } from './lib/server.js';
import { probe, sdkVersions, bundledCliPath } from './lib/sdk.js';
import { startUpstreamProxy } from './lib/upstream.js';

const HOST = '127.0.0.1';
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
// Empty scratch directory for the CLI.
const cwd = path.join(pluginDir, '.scratch-cwd');

/** @type {ConfigStore} */
let config;
/** @type {import('node:http').Server | null} */
let server = null;
/** @type {import('node:http').Server | null} */
let upstream = null;
const active = new Set();

export const info = {
    id: 'claude-bridge',
    name: 'ClaudeBridge',
    description: 'Chat through the Claude Agent SDK using your own Claude Code login (Pro/Max plan).',
};

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    fs.mkdirSync(cwd, { recursive: true });
    config = new ConfigStore(path.join(pluginDir, 'config.json'));
    upstream = await startUpstreamProxy(() => config.data);

    server = createServer({ getConfig: () => config.data, cwd, active });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.data.port, HOST, () => resolve(undefined));
    });
    console.info(`[claude-bridge] Listening on http://${HOST}:${config.data.port}/v1`);

    router.get('/status', async (req, res) => {
        const base = { ...sdkVersions(), cliPath: bundledCliPath(), endpoint: `http://${HOST}:${config.data.port}/v1` };
        try {
            const result = await probe(cwd, req.query.refresh === '1');
            const { models, ...rest } = result;
            res.json({ ok: true, ...base, ...rest, modelCount: models.length });
        } catch (error) {
            res.json({ ok: false, ...base, error: error.message });
        }
    });

    router.get('/config', (_req, res) => {
        res.json({ ...config.data, endpoint: `http://${HOST}:${config.data.port}/v1` });
    });

    router.post('/config', (req, res) => {
        res.json(config.update(req.body));
    });
}

export async function exit() {
    for (const controller of active) controller.abort();
    if (server) {
        await new Promise(resolve => server.close(() => resolve(undefined)));
        server = null;
    }
    if (upstream) {
        await new Promise(resolve => upstream.close(() => resolve(undefined)));
        upstream = null;
    }
}
