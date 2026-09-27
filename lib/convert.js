/**
 * Converts incoming chat requests (OpenAI chat-completions or Anthropic Messages
 * format) into Anthropic-style turns for the Agent SDK.
 */

import { HttpError } from './errors.js';

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s;
const EXAMPLE_NAMES = new Set(['example_user', 'example_assistant']);

/**
 * @typedef {{ type: 'text', text: string } | { type: 'image', source: object }} Block
 * @typedef {{ role: 'user' | 'assistant', content: Block[] }} Turn
 * @typedef {{ system: string, history: Turn[], current: Block[] }} Conversation
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
 * @param {string} system
 * @param {Turn[]} turns
 * @returns {Conversation}
 */
export function splitTurns(system, turns) {
    // The Agent SDK only takes a user message as input.
    if (turns.length > 0 && turns[turns.length - 1].role === 'assistant') {
        throw new HttpError(400, 'Prefill is not supported through ClaudeBridge: the request must end with a user message.');
    }

    let current = turns.length > 0 ? turns.pop().content : [];
    if (turns.length > 0 && turns[0].role === 'assistant') {
        turns.unshift({ role: 'user', content: [{ type: 'text', text: '[Start]' }] });
    }
    if (current.length === 0) {
        current = [{ type: 'text', text: '[Continue]' }];
    }
    return { system, history: turns, current };
}

/**
 * @param {any} content OpenAI message content
 * @param {boolean} allowImages
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
                console.warn('[claude-bridge] Dropping image that is not a base64 data URL');
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
    for (; i < list.length; i++) {
        const msg = list[i];
        const role = msg?.role === 'assistant' ? 'assistant' : 'user';
        const blocks = openAiBlocks(msg?.content, role === 'user');
        const first = blocks.find(b => b.type === 'text');
        if (first && msg?.name && !EXAMPLE_NAMES.has(msg.name)) {
            first.text = `${msg.name}: ${first.text}`;
        }
        pushTurn(turns, role, blocks);
    }
    return splitTurns(systemParts.join('\n\n'), turns);
}

/**
 * Keeps the block types a chat turn can carry.
 * @param {any} content Anthropic message content
 * @param {boolean} allowImages
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
