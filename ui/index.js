import { renderExtensionTemplateAsync, getContext } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import { SECRET_KEYS, secret_state, writeSecret, deleteSecret, readSecretState } from '../../../../secrets.js';
import { openInsights } from './insights.js';

const API = '/api/plugins/claude-bridge';
const SECRET_LABEL = 'ClaudeBridge plugin';
const PROXY_PRESET = 'ClaudeBridge';
const TEMPLATE_PATH = new URL('.', import.meta.url).pathname.replace(/^.*\/scripts\/extensions\//, '').replace(/\/$/, '');

/** @param {RequestInit} [init] */
async function api(path, init = {}) {
    const response = await fetch(`${API}${path}`, { ...init, headers: getRequestHeaders() });
    if (!response.ok) {
        throw new Error(response.status === 404
            ? 'Plugin not loaded. Set enableServerPlugins: true in config.yaml, install the server plugin (see the ClaudeBridge README), then restart SillyTavern.'
            : `Plugin error ${response.status}`);
    }
    return response.json();
}

/** @param {{ utilization: number | null, resets_at: string | null } | null} window */
function quotaRow(label, window) {
    if (!window || window.utilization == null) return null;
    const pct = Math.max(0, Math.min(100, window.utilization));
    const resets = window.resets_at ? `, resets ${new Date(window.resets_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}` : '';
    const row = $('<div class="claude-bridge-quota-row"></div>');
    row.append($('<span></span>').text(`${label}: ${Math.round(pct)}% used${resets}`));
    row.append($('<div class="claude-bridge-quota-bar"><div></div></div>').find('div').css('width', `${pct}%`).end());
    return row;
}

let lastNoticeId = null;

async function showNotices() {
    const { lastId, notices } = await api('/notices');
    if (lastNoticeId !== null) {
        // a lower id means the plugin restarted and its counter reset.
        const since = lastId < lastNoticeId ? 0 : lastNoticeId;
        for (const notice of notices.filter(n => n.id > since)) toastr.warning(notice.message, 'ClaudeBridge');
    }
    lastNoticeId = lastId;
}

async function refreshStatus(force = false) {
    const status = $('#claude_bridge_status');
    const quota = $('#claude_bridge_quota').empty();
    status.removeClass('ok error').text('Checking…');
    try {
        const s = await api(`/status${force ? '?refresh=1' : ''}`);
        if (!s.ok) {
            status.addClass('error').text(`Claude Code error: ${s.error}`);
        } else if (s.usingApiKey || s.apiProvider !== 'firstParty') {
            status.addClass('error').text(`Claude Code is using ${s.apiProvider ?? 'an API key'}, not a subscription login.`);
        } else if (!s.loggedIn) {
            status.addClass('error').text(`Not logged in. Run "${s.cliPath}" in a terminal and use /login.`);
        } else {
            status.addClass('ok').text(`Logged in: ${s.subscription} · Claude Code ${s.cliVersion}`);
            const rows = [quotaRow('5-hour window', s.quota?.fiveHour), quotaRow('Weekly', s.quota?.sevenDay)].filter(Boolean);
            if (rows.length) quota.append(...rows, $('<small class="claude-bridge-notice"></small>').text('Limits are shared with Claude Code, Claude.ai chat and Claude Cowork.'));
        }
    } catch (error) {
        status.addClass('error').text(error.message);
    }
}

let endpoint = null;
const trimSlash = url => String(url ?? '').replace(/\/+$/, '');

function renderConfig(config) {
    if (config.endpoint) endpoint = trimSlash(config.endpoint);
    $('#claude_bridge_effort').val(config.effort);
    $('#claude_bridge_thinking').val(config.thinking);
    $('#claude_bridge_budget').val(config.thinkingBudget);
    $('#claude_bridge_budget_row').toggle(config.thinking === 'enabled');
    $('#claude_bridge_cache_ttl').val(config.cacheTtl);
    $('#claude_bridge_strip_sdk_identity').prop('checked', config.stripSdkIdentity);
    $('#claude_bridge_refuse_model_swap').prop('checked', config.refuseModelSwap);
}

async function saveConfig() {
    const config = await api('/config', {
        method: 'POST',
        body: JSON.stringify({
            effort: $('#claude_bridge_effort').val(),
            thinking: $('#claude_bridge_thinking').val(),
            thinkingBudget: Number($('#claude_bridge_budget').val()),
            cacheTtl: $('#claude_bridge_cache_ttl').val(),
            stripSdkIdentity: $('#claude_bridge_strip_sdk_identity').prop('checked'),
            refuseModelSwap: $('#claude_bridge_refuse_model_swap').prop('checked'),
        }),
    });
    renderConfig(config);
}

async function connectClaude() {
    try {
        const config = await api('/config');
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('claude').trigger('change');
        $('#openai_reverse_proxy_name').val(PROXY_PRESET);
        $('#openai_reverse_proxy').val(config.endpoint);
        $('#openai_proxy_access_key').val(config.secret);
        $('#save_proxy').trigger('click');
        toastr.success('Pick a model in the Claude model list.', 'ClaudeBridge connected');
    } catch (error) {
        toastr.error(error.message, 'ClaudeBridge');
    }
}

async function connectCustom() {
    try {
        const config = await api('/config');
        await readSecretState();
        for (const secret of secret_state[SECRET_KEYS.CUSTOM] ?? []) {
            if (secret.label === SECRET_LABEL) await deleteSecret(SECRET_KEYS.CUSTOM, secret.id);
        }
        await writeSecret(SECRET_KEYS.CUSTOM, config.secret, SECRET_LABEL);

        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('custom').trigger('change');
        $('#custom_api_url_text').val(config.endpoint).trigger('input');
        $('#api_button_openai').trigger('click');
        toastr.success('Pick a model in the Custom model list.', 'ClaudeBridge connected');
    } catch (error) {
        toastr.error(error.message, 'ClaudeBridge');
    }
}

async function tagGeneration(data) {
    if (!endpoint || ![data?.reverse_proxy, data?.custom_url].some(url => trimSlash(url) === endpoint)) return;
    const context = getContext();
    const group = context.groupId ? context.groups.find(g => g.id == context.groupId) : null;
    const char = group ? group.name : context.characters[context.characterId]?.name;
    try {
        await api('/tag', { method: 'POST', body: JSON.stringify({ chat: context.chatId, char }) });
    } catch {
    }
}

function showInsights() {
    openInsights({ api, templatePath: TEMPLATE_PATH }).catch(error => toastr.error(error.message, 'ClaudeBridge'));
}

jQuery(async () => {
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings').append(html);

    $('#extensionsMenu').append(`
        <div id="claude_bridge_wand" class="list-group-item flex-container flexGap5" title="ClaudeBridge usage over time">
            <div class="fa-solid fa-chart-simple extensionsMenuExtensionButton"></div>
            <span>Usage Insights</span>
        </div>`);
    $('#claude_bridge_wand, #claude_bridge_insights').on('click', showInsights);

    $('#claude_bridge_refresh').on('click', () => refreshStatus(true));
    $('#claude_bridge_connect_claude').on('click', connectClaude);
    $('#claude_bridge_connect_custom').on('click', connectCustom);
    $('#claude_bridge_effort, #claude_bridge_thinking, #claude_bridge_budget, #claude_bridge_cache_ttl, #claude_bridge_strip_sdk_identity, #claude_bridge_refuse_model_swap')
        .on('change', () => saveConfig().catch(error => toastr.error(error.message, 'ClaudeBridge')));

    try {
        renderConfig(await api('/config'));
        await showNotices();
    } catch {
    }
    eventSource.on(event_types.GENERATION_ENDED, () => showNotices().catch(() => {}));
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, tagGeneration);
    await refreshStatus();
});
