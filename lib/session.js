import crypto from 'node:crypto';
import { blocksText } from './convert.js';

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

/**
 * One-shot SessionStore.
 * @param {string} sessionId
 * @param {object[]} entries
 */
export function oneShotStore(sessionId, entries) {
    return {
        async load(key) {
            return key.sessionId === sessionId && !key.subpath ? entries : null;
        },
        async append() {},
    };
}

/**
 * Fallback when resume is off.
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
