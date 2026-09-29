import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { blocksText } from './convert.js';

const SWEEP_DELAY_MS = 5_000;
let sweepTimer = null;

/**
 * Builds Claude Code transcript entries for prior turns so the SDK can resume
 * them as a real multi-turn session.
 * @param {import('./convert.js').Turn[]} turns Alternating turns
 * @param {{ sessionId: string, cwd: string, version: string, model: string }} meta
 */
export function buildSessionEntries(turns, { sessionId, cwd, version, model }) {
    const envelope = { isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd, sessionId, version, gitBranch: '' };
    const entries = [];
    let parentUuid = null;
    const start = Date.now() - turns.length * 1000;

    turns.forEach((turn, index) => {
        const uuid = crypto.randomUUID();
        const timestamp = new Date(start + index * 1000).toISOString();
        if (turn.role === 'user') {
            entries.push({ parentUuid, ...envelope, type: 'user', message: { role: 'user', content: turn.content }, uuid, timestamp });
        } else {
            const text = blocksText(turn.content);
            entries.push({
                parentUuid,
                ...envelope,
                type: 'assistant',
                message: {
                    id: `msg_${uuid.replaceAll('-', '')}`,
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [{ type: 'text', text }],
                    stop_reason: 'end_turn',
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
                requestId: `req_${uuid.replaceAll('-', '')}`,
                uuid,
                timestamp,
            });
        }
        parentUuid = uuid;
    });
    return entries;
}

/** One-shot SessionStore. */
export function oneShotStore(sessionId, entries) {
    return {
        async load(key) {
            return key.sessionId === sessionId && !key.subpath ? entries : null;
        },
        async append() {},
    };
}

/**
 * Deletes the temp folders the SDK builds to resume a session.
 * @param {Set<unknown>} [active]
 */
export async function sweepResumeDirs(cwd, active) {
    let project;
    try {
        project = fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200).toLowerCase();
    } catch {
        return;
    }
    const tmp = os.tmpdir();
    const names = await fs.promises.readdir(tmp).catch(() => []);
    await Promise.all(names.filter(name => name.startsWith('claude-resume-')).map(async name => {
        const dir = path.join(tmp, name);
        try {
            const projects = await fs.promises.readdir(path.join(dir, 'projects'));
            if (!projects.some(p => p.toLowerCase().startsWith(project)) || active?.size) return;
            await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch {
        }
    }));
}

/** Sweeps again after the SDK's own cleanup has had its turn. */
export function scheduleSweep(cwd, active) {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => sweepResumeDirs(cwd, active), SWEEP_DELAY_MS);
    sweepTimer.unref();
}

/**
 * Fallback when a resume can't be loaded.
 * @param {import('./convert.js').Turn[]} history
 * @param {import('./convert.js').Block[]} current
 */
export function foldIntoPrompt(history, current) {
    if (history.length === 0) {
        return current;
    }
    const transcript = history
        .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${blocksText(turn.content)}`)
        .join('\n\n');
    const images = history.flatMap(turn => turn.content.filter(b => b.type === 'image'));
    return [
        { type: 'text', text: `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\nContinue the conversation as the Assistant. The latest User message follows.` },
        ...images,
        ...current,
    ];
}
