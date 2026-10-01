/**
 * Converts incoming chat requests into Anthropic-style turns for the Agent SDK.
 */

import { HttpError } from './errors.js';
import { warn } from './notices.js';

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s;
const EXAMPLE_NAMES = new Set(['example_user', 'example_assistant']);
export const SYSTEM_OPEN = '<claude-bridge-system>';
export const SYSTEM_CLOSE = '</claude-bridge-system>';

/**
 * @typedef {{ type: 'text', text: string } | { type: 'image', source: object }} Block
 * @typedef {{ role: 'user' | 'assistant', content: Block[] }} Turn
 * @typedef {{ system: string, history: Turn[], current: Block[], misplacedSystem?: { index: number, text: string }[] }} Conversation
 */

/** @param {Block[]} blocks */
export function blocksText(blocks) {
    return blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
}

/**
 * @param {Turn[]} turns
 * @param {'user' | 'assistant'} role
 * @param {Block[]} blocks
 */
function pushTurn(turns, role, blocks) {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
        last.content.push(...blocks);
    } else {
        turns.push({ role, content: blocks });
    }
}

/**
 * Splits merged turns into prior history.
 * @param {Turn[]} turns
 * @returns {Conversation}
 */
export function splitTurns(system, turns) {
    if (turns.length > 0 && turns[turns.length - 1].role === 'assistant') {
        throw new HttpError(400, 'The request must end with a user message.');
    }

    let current = turns.length > 0 ? turns.pop().content : [];
    if (current.length === 0) {
        current = [{ type: 'text', text: '[Continue]' }];
    }
    return { system, history: turns, current };
}

/**
 * @param {any} content OpenAI message content
 * @returns {Block[]}
 */
function openAiBlocks(content, allowImages) {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const blocks = [];
    for (const part of content) {
        if (part?.type === 'text' && part.text) {
            blocks.push({ type: 'text', text: part.text });
        } else if (part?.type === 'image_url' && allowImages) {
            const match = DATA_URL.exec(part.image_url?.url ?? '');
            if (match) {
                blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
            } else {
                warn('An image was left out because it was not sent as a base64 data URL.');
            }
        }
    }
    return blocks;
}

/**
 * @param {any[]} messages OpenAI chat-completions messages
 * @returns {Conversation}
 */
export function fromOpenAi(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const systemParts = [];
    let i = 0;

    for (; i < list.length && list[i]?.role === 'system'; i++) {
        const text = blocksText(openAiBlocks(list[i].content, false));
        if (text) systemParts.push(text);
    }

    /** @type {Turn[]} */
    const turns = [];
    const misplacedSystem = [];
    let pending = [];
    let lastRole = null;
    for (; i < list.length; i++) {
        const msg = list[i];
        if (msg?.role === 'system') {
            // the proxy turns this back into a system message
            const text = blocksText(openAiBlocks(msg.content, false));
            if (text) {
                pushTurn(turns, 'user', [{ type: 'text', text: `${SYSTEM_OPEN}${text}${SYSTEM_CLOSE}` }]);
                pending.push({ index: i, text });
            }
            continue;
        }
        const role = msg?.role === 'assistant' ? 'assistant' : 'user';
        const blocks = openAiBlocks(msg?.content, role === 'user');
        const first = blocks.find(b => b.type === 'text');
        if (first && msg?.name && !EXAMPLE_NAMES.has(msg.name)) {
            first.text = `${msg.name}: ${first.text}`;
        }
        if (blocks.length === 0) continue;
        // a system section must sit between a user message and an assistant one
        if (lastRole !== 'user' || role === 'user') misplacedSystem.push(...pending);
        pending = [];
        lastRole = role;
        pushTurn(turns, role, blocks);
    }
    if (lastRole !== 'user') misplacedSystem.push(...pending);
    return { ...splitTurns(systemParts.join('\n\n'), turns), misplacedSystem };
}

/**
 * Models that take `system` messages inside `messages`.
 * https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 */
export function supportsMidSystem(model) {
    return /^claude-(?:opus-4-8|opus-5|opus-5-5|sonnet-5-5|fable-5|fable-5-1|mythos-5|mythos-5-1)(?:-\d{8})?(?:\[1m\])?$/i.test(String(model ?? ''));
}

/**
 * Rejects mid-chat system messages the API would refuse.
 * @param {Conversation} conversation
 */
export function checkSystemPlacement(conversation, model) {
    const bad = conversation.misplacedSystem?.[0];
    if (!bad || !supportsMidSystem(model)) return;
    const flat = bad.text.trim().replace(/\s+/g, ' ');
    const preview = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
    throw new HttpError(400, `System message #${bad.index + 1} ("${preview}") is in a spot ${model} does not accept. A system message inside the chat has to come right after a user message, and be followed by an assistant message or be the last message. Move it in your prompt settings and retry.`);
}

/**
 * Keeps the block types a chat turn can carry.
 * @param {any} content Anthropic message content
 * @returns {Block[]}
 */
function anthropicBlocks(content, allowImages) {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const blocks = [];
    for (const block of content) {
        if (block?.type === 'text' && block.text) {
            blocks.push({ type: 'text', text: block.text });
        } else if (block?.type === 'image' && allowImages && block.source) {
            blocks.push({ type: 'image', source: block.source });
        }
    }
    return blocks;
}

/**
 * @param {any} body Anthropic Messages request body
 * @returns {Conversation}
 */
export function fromAnthropic(body) {
    const system = typeof body?.system === 'string'
        ? body.system
        : blocksText(anthropicBlocks(body?.system, false));

    /** @type {Turn[]} */
    const turns = [];
    for (const msg of Array.isArray(body?.messages) ? body.messages : []) {
        const role = msg?.role === 'assistant' ? 'assistant' : 'user';
        pushTurn(turns, role, anthropicBlocks(msg?.content, role === 'user'));
    }
    return splitTurns(system, turns);
}
