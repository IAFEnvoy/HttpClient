// ── Tauri — 通过全局 window.__TAURI__.core.invoke 调用插件 ─────
const { invoke } = window.__TAURI__.core;

async function tauriOpen(options = {}) {
  return await invoke('plugin:dialog|open', { options });
}
async function tauriSave(options = {}) {
  return await invoke('plugin:dialog|save', { options });
}
async function tauriReadFile(path) {
  const arr = await invoke('plugin:fs|read_file', { path });
  return arr instanceof ArrayBuffer ? new Uint8Array(arr) : Uint8Array.from(arr);
}
async function tauriWriteFile(path, contents) {
  const data = new TextEncoder().encode(contents);
  await invoke('plugin:fs|write_file', data, { headers: { path } });
}

// ── Tauri HTTP fetch (custom Rust command, zero scope limit) ─────
async function tauriFetch(input, init = {}) {
  const signal = init.signal;
  if (signal?.aborted) throw new Error('Request cancelled');

  // Build body as Uint8Array
  let body = null;
  if (init.body) {
    if (typeof init.body === 'string') {
      body = Array.from(new TextEncoder().encode(init.body));
    } else if (init.body instanceof URLSearchParams) {
      body = Array.from(new TextEncoder().encode(init.body.toString()));
    } else if (init.body instanceof FormData) {
      throw new Error('FormData not supported; use raw body instead');
    } else if (init.body instanceof Blob) {
      body = Array.from(new Uint8Array(await init.body.arrayBuffer()));
    }
  }

  const url = typeof input === 'string' ? input : input.url || '';
  const method = init.method || 'GET';

  // Convert headers to [key, value][] format, de-dupe
  const rawHeaders = init.headers || {};
  let headerPairs = [];
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((v, k) => headerPairs.push([k, v]));
  } else if (Array.isArray(rawHeaders)) {
    headerPairs = rawHeaders;
  } else {
    headerPairs = Object.entries(rawHeaders);
  }
  const seen = new Set();
  const headers = headerPairs.filter(([k]) => {
    const low = k.toLowerCase();
    if (seen.has(low)) return false;
    seen.add(low);
    return true;
  });

  console.log('[fetch]', method, url);
  console.log('[fetch] headers:', JSON.stringify(headers));

  try {
    const result = await invoke('fetch', {
      request: {
        method,
        url,
        headers,
        body: body || undefined,
      }
    });
    console.log('[fetch] result status:', result.status, 'size:', result.body?.length);

    const { status, statusText, headers: respHeaders, body: bodyArr } = result;
    const bodyU8 = new Uint8Array(bodyArr || []);
    const responseHeaders = respHeaders || {};

    return {
      status,
      statusText: statusText || '',
      headers: {
        forEach: (cb) => { for (const [k, v] of Object.entries(responseHeaders)) cb(v, k); },
        get: (name) => responseHeaders[name.toLowerCase()] || null,
      },
      bodyU8,
      async blob() { return new Blob([bodyU8]); },
      async text() { return new TextDecoder().decode(bodyU8); },
      async json() { return JSON.parse(new TextDecoder().decode(bodyU8)); },
    };
  } catch (e) {
    console.error('[fetch] error:', e);
    throw e;
  }
}

// ── App State ────────────────────────────────────────────────────
function newTabState(method, url) {
  return {
    method: method || 'GET',
    url: url || '',
    name: '',
    params: [],
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true, readonly: true }],
    bodyType: 'none',
    rawContentType: 'application/json',
    rawBody: '',
    formdataFields: [],
    urlencodedFields: [],
    formdataMode: 'table',
    formdataRaw: '',
    urlencodedMode: 'table',
    urlencodedRaw: '',
    binaryPath: '',
    binaryMode: 'file',
    binaryRaw: '',
    jsonBody: '',
    authType: 'none',
    bearerToken: '',
    basicUsername: '',
    basicPassword: '',
    apiKeyKey: '',
    apiKeyValue: '',
    apiKeyAddTo: 'header',
    script: '',
  };
}

const state = {
  tabs: [newTabState('GET', '')],
  activeTab: 0,
  currentEnv: 'dev',
  envs: {},
  history: [],
  historyMax: 100,
  currentResponse: null,
  aborter: null,
};

function getActiveTab() { return state.tabs[state.activeTab]; }

// ── Persistence keys ─────────────────────────────────────────────
const LS_ENVS = 'httpclient_envs';
const LS_HISTORY = 'httpclient_history';
const LS_ACTIVE_ENV = 'httpclient_active_env';
const LS_TABS = 'httpclient_tabs';
const LS_ACTIVE_TAB = 'httpclient_active_tab';

// ── DOM refs (populated on DOMContentLoaded) ─────────────────────
let $ = () => { };

// ═════════════════════════════════════════════════════════════════
//  KV TABLE UTILITIES
// ═════════════════════════════════════════════════════════════════

/** Create one KV row for any table */
function createKVRow(prefix, data, showFileBtn) {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const checked = data.enabled !== false ? 'checked' : '';
  const keyVal = escHtml(data.key || '');
  const valueVal = escHtml(data.value || '');

  row.innerHTML = `
    <input type="checkbox" class="cb-enable" ${checked} title="启用/禁用" />
    <input type="text" class="kv-key" placeholder="Key" value="${keyVal}" ${data.readonly ? 'readonly title="由 Body 类型自动管理，不可编辑"' : ''} />
    <input type="text" class="kv-value" placeholder="Value" value="${valueVal}" ${data.readonly ? 'readonly title="由 Body 类型自动管理，不可编辑"' : ''} />
    ${showFileBtn ? '<button class="kv-file-btn" title="选择文件">选文件</button><span class="kv-file-type"></span>' : ''}
    <button class="btn-remove" title="删除">删除</button>
  `;

  // Lock readonly rows instantly
  if (data.readonly) {
    const cb = row.querySelector('.cb-enable');
    if (cb) { cb.disabled = true; cb.style.opacity = '0.6'; cb.title = '由 Body 类型自动管理'; }
    const rm = row.querySelector('.btn-remove');
    if (rm) rm.style.display = 'none';
    row.querySelectorAll('input[type="text"]').forEach(inp => { inp.style.opacity = '0.6'; });
  }

  // Enable toggle
  const cb = row.querySelector('.cb-enable');
  cb.addEventListener('change', () => syncFromTables());

  // Key change
  row.querySelector('.kv-key').addEventListener('input', () => syncFromTables());
  // Value change
  row.querySelector('.kv-value').addEventListener('input', () => syncFromTables());

  // Remove
  row.querySelector('.btn-remove').addEventListener('click', () => {
    row.remove();
    syncFromTables();
  });

  // File picker (form-data)
  const fileBtn = row.querySelector('.kv-file-btn');
  if (fileBtn) {
    fileBtn.addEventListener('click', async () => {
      try {
        const selected = await tauriOpen({ multiple: false });
        if (selected) {
          row.querySelector('.kv-value').value = selected;
          row.querySelector('.kv-file-type').textContent = '文件';
          syncFromTables();
        }
      } catch (e) { /* user cancelled */ }
    });
  }

  return row;
}

/** Escape HTML for innerHTML */
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Read all rows from a KV table container into state arrays */
function readKVTable(containerId, includeFileType) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  const rows = container.querySelectorAll('.kv-row');
  const result = [];
  rows.forEach(row => {
    const cb = row.querySelector('.cb-enable');
    const keyEl = row.querySelector('.kv-key');
    const valEl = row.querySelector('.kv-value');
    const fileTypeEl = row.querySelector('.kv-file-type');
    const entry = {
      key: keyEl ? keyEl.value : '',
      value: valEl ? valEl.value : '',
      enabled: cb ? cb.checked : true,
    };
    if (includeFileType && fileTypeEl && fileTypeEl.textContent.includes('file')) {
      entry.fieldType = 'file';
      entry.text = '';
      entry.filePath = entry.value;
    } else if (includeFileType) {
      entry.fieldType = 'text';
      entry.text = entry.value;
      entry.filePath = '';
    }
    result.push(entry);
  });
  return result;
}

/** Sync all table data from DOM into state */
function syncFromTables() {
  const t = getActiveTab();
  t.params = readKVTable('params-table');
  t.headers = readKVTable('headers-table');
  t.formdataFields = readKVTable('formdata-table', true);
  t.urlencodedFields = readKVTable('urlencoded-table');
  state.envs[state.currentEnv] = readKVEnvs();
}

/** Read env table into key-value object */
function readKVEnvs() {
  const rows = document.querySelectorAll('#env-table .kv-row');
  const obj = {};
  rows.forEach(row => {
    const key = row.querySelector('.kv-key')?.value?.trim();
    const val = row.querySelector('.kv-value')?.value || '';
    const enabled = row.querySelector('.cb-enable')?.checked !== false;
    if (key && enabled) obj[key] = val;
  });
  return obj;
}

/** Render a whole KV table from array */
function renderKVTable(containerId, items, showFileBtn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  (items || []).forEach(item => {
    container.appendChild(createKVRow(containerId, item, showFileBtn));
  });
  // After render, lock Content-Type row if readonly
  if (containerId === 'headers-table') {
    const ctHeader = (items || []).find(h => h.key && h.key.toLowerCase() === 'content-type');
    if (ctHeader && ctHeader.enabled && ctHeader.readonly) {
      const rows = container.querySelectorAll('.kv-row');
      rows.forEach(row => {
        const keyInput = row.querySelector('.kv-key');
        if (!keyInput || keyInput.value !== 'Content-Type') return;
        const inputs = row.querySelectorAll('input[type="text"]');
        inputs.forEach(inp => { inp.readOnly = true; inp.style.opacity = '0.6'; });
        const cb = row.querySelector('.cb-enable');
        if (cb) { cb.disabled = true; cb.style.opacity = '0.6'; }
        const rm = row.querySelector('.btn-remove');
        if (rm) rm.style.display = 'none';
      });
    }
  }
}

/** Add a blank row */
function addKVRow(containerId, showFileBtn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.appendChild(createKVRow(containerId, { key: '', value: '', enabled: true }, showFileBtn));
}

// ── Tab switching ────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      // Activate tab
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // Activate panel
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + tabName).classList.add('active');
    });
  });

  // Response tabs
  document.querySelectorAll('.resp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.respTab;
      document.querySelectorAll('.resp-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.resp-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('resp-' + tabName).classList.add('active');
    });
  });
}

// ── Body panel ──────────────────────────────────────────────────
function initBodyPanel() {
  const T = () => getActiveTab();

  const typeRadios = document.querySelectorAll('input[name="body-type"]');
  typeRadios.forEach(r => {
    r.addEventListener('change', () => {
      T().bodyType = r.value;
      updateBodySubPanel();
      syncContentTypeHeader(T());
    });
  });

  // Raw content-type
  const rawCT = document.getElementById('raw-content-type');
  const rawBody = document.getElementById('raw-body');
  const rawPreview = document.getElementById('raw-preview');
  if (rawBody) rawBody.addEventListener('input', () => { T().rawBody = rawBody.value; updateRawPreview(); });
  if (rawCT) rawCT.addEventListener('input', () => { T().rawContentType = rawCT.value; updateRawPreview(); syncContentTypeHeader(T()); });

  function updateRawPreview() {
    const rw = T().rawBody, ct = T().rawContentType;
    if (!rawPreview || !rw.trim()) { if (rawPreview) rawPreview.classList.add('hidden'); return; }
    rawPreview.classList.remove('hidden');
    let lang = 'text';
    if (ct.includes('json')) lang = 'json';
    else if (ct.includes('xml') || ct.includes('html')) lang = 'xml';
    rawPreview.innerHTML = '<code>' + renderHighlighted(rw, lang) + '</code>';
  }

  // JSON body
  const jsonBody = document.getElementById('json-body');
  const jsonPreview = document.getElementById('json-preview');
  if (jsonBody) jsonBody.addEventListener('input', () => {
    T().jsonBody = jsonBody.value;
    if (jsonPreview) {
      if (!T().jsonBody.trim()) { jsonPreview.classList.add('hidden'); return; }
      jsonPreview.classList.remove('hidden');
      jsonPreview.innerHTML = '<code>' + renderHighlighted(T().jsonBody, 'json') + '</code>';
    }
  });

  // Form-data mode switch
  const formdataMode = document.getElementById('formdata-mode');
  const formdataTableWrap = document.getElementById('formdata-table-wrap');
  const formdataRaw = document.getElementById('formdata-raw');
  if (formdataMode) formdataMode.addEventListener('change', () => {
    T().formdataMode = formdataMode.value;
    updateFormSubPanel();
  });
  if (formdataRaw) formdataRaw.addEventListener('input', () => { T().formdataRaw = formdataRaw.value; });

  // Urlencoded mode switch
  const urlencodedMode = document.getElementById('urlencoded-mode');
  const urlencodedTableWrap = document.getElementById('urlencoded-table-wrap');
  const urlencodedRaw = document.getElementById('urlencoded-raw');
  if (urlencodedMode) urlencodedMode.addEventListener('change', () => {
    T().urlencodedMode = urlencodedMode.value;
    updateFormSubPanel();
  });
  if (urlencodedRaw) urlencodedRaw.addEventListener('input', () => { T().urlencodedRaw = urlencodedRaw.value; });

  function updateFormSubPanel() {
    const fm = T().formdataMode, um = T().urlencodedMode;
    if (formdataTableWrap) formdataTableWrap.classList.toggle('hidden', fm !== 'table');
    if (formdataRaw) formdataRaw.classList.toggle('hidden', fm !== 'raw');
    if (urlencodedTableWrap) urlencodedTableWrap.classList.toggle('hidden', um !== 'table');
    if (urlencodedRaw) urlencodedRaw.classList.toggle('hidden', um !== 'raw');
  }

  // Binary mode + file picker
  const binaryModeRadios = document.querySelectorAll('input[name="binary-mode"]');
  const binaryFileWrap = document.getElementById('binary-file-wrap');
  const binaryRaw = document.getElementById('binary-raw');
  binaryModeRadios.forEach(r => r.addEventListener('change', () => {
    T().binaryMode = r.value;
    if (binaryFileWrap) binaryFileWrap.classList.toggle('hidden', T().binaryMode !== 'file');
    if (binaryRaw) binaryRaw.classList.toggle('hidden', T().binaryMode !== 'raw');
  }));
  if (binaryRaw) binaryRaw.addEventListener('input', () => { T().binaryRaw = binaryRaw.value; });

  const btnPickBinary = document.getElementById('btn-pick-binary');
  if (btnPickBinary) btnPickBinary.addEventListener('click', async () => {
    try {
      const f = await tauriOpen({ multiple: false });
      if (f) { document.getElementById('binary-path').value = f; T().binaryPath = f; }
    } catch (e) { /* cancelled */ }
  });
}

function updateBodySubPanel() {
  const t1 = getActiveTab();
  console.log(t1)
  const type = t1.bodyType || 'none';
  document.querySelectorAll('.body-sub-panel').forEach(p => p.classList.remove('active'));
  const panel = document.querySelector(`.body-sub-panel[data-body="${type}"]`);
  if (panel) panel.classList.add('active');
  else {
    const fallback = document.querySelector('.body-sub-panel[data-body="none"]');
    if (fallback) fallback.classList.add('active');
  }
  // Sync form/binary sub-modes
  const fdTable = document.getElementById('formdata-table-wrap');
  const fdRaw = document.getElementById('formdata-raw');
  if (fdTable) fdTable.classList.toggle('hidden', t1.formdataMode !== 'table');
  if (fdRaw) fdRaw.classList.toggle('hidden', t1.formdataMode !== 'raw');
  const ueTable = document.getElementById('urlencoded-table-wrap');
  const ueRaw = document.getElementById('urlencoded-raw');
  if (ueTable) ueTable.classList.toggle('hidden', t1.urlencodedMode !== 'table');
  if (ueRaw) ueRaw.classList.toggle('hidden', t1.urlencodedMode !== 'raw');
  const bfWrap = document.getElementById('binary-file-wrap');
  const bRaw = document.getElementById('binary-raw');
  if (bfWrap) bfWrap.classList.toggle('hidden', t1.binaryMode !== 'file');
  if (bRaw) bRaw.classList.toggle('hidden', t1.binaryMode !== 'raw');
}

/** Sync Content-Type header — only none disables; all others auto-set & readonly */
function syncContentTypeHeader(tab) {
  syncFromTables();
  const headers = tab.headers;
  const ctHeader = headers.find(h => h.key && h.key.toLowerCase() === 'content-type');

  if (tab.bodyType === 'none') {
    if (ctHeader) {
      ctHeader.enabled = false;
      ctHeader.readonly = true;
    }
  } else {
    let ct = '';
    if (tab.bodyType === 'json') ct = 'application/json';
    else if (tab.bodyType === 'raw') ct = tab.rawContentType;
    else if (tab.bodyType === 'x-www-form-urlencoded') ct = 'application/x-www-form-urlencoded';
    else if (tab.bodyType === 'form-data') ct = 'multipart/form-data';
    else if (tab.bodyType === 'binary') ct = 'application/octet-stream';

    if (ctHeader) {
      ctHeader.value = ct;
      ctHeader.enabled = true;
      ctHeader.readonly = true; // mark for render
    } else {
      headers.unshift({ key: 'Content-Type', value: ct, enabled: true, readonly: true });
    }
  }
  renderKVTable('headers-table', headers, false, 'headers-table');
}

// ── Auth panel ──────────────────────────────────────────────────
function initAuthPanel() {
  const authRadios = document.querySelectorAll('input[name="auth-type"]');
  authRadios.forEach(r => {
    r.addEventListener('change', () => {
      getActiveTab().authType = r.value;
      updateAuthSubPanel();
    });
  });
  const bearerInput = document.getElementById('bearer-token');
  const basicUser = document.getElementById('basic-username');
  const basicPass = document.getElementById('basic-password');
  const apiKeyKey = document.getElementById('apikey-key');
  const apiKeyVal = document.getElementById('apikey-value');
  const apiKeyAddTo = document.getElementById('apikey-addto');

  if (bearerInput) bearerInput.addEventListener('input', () => getActiveTab().bearerToken = bearerInput.value);
  if (basicUser) basicUser.addEventListener('input', () => getActiveTab().basicUsername = basicUser.value);
  if (basicPass) basicPass.addEventListener('input', () => getActiveTab().basicPassword = basicPass.value);
  if (apiKeyKey) apiKeyKey.addEventListener('input', () => getActiveTab().apiKeyKey = apiKeyKey.value);
  if (apiKeyVal) apiKeyVal.addEventListener('input', () => getActiveTab().apiKeyValue = apiKeyVal.value);
  if (apiKeyAddTo) apiKeyAddTo.addEventListener('change', () => getActiveTab().apiKeyAddTo = apiKeyAddTo.value);
}

function updateAuthSubPanel() {
  document.querySelectorAll('.auth-sub-panel').forEach(p => p.classList.remove('active'));
  const t2 = getActiveTab();
  const panel2 = document.querySelector(`.auth-sub-panel[data-auth="${t2.authType}"]`);
  if (panel2) panel2.classList.add('active');
}

// ── Env panel ───────────────────────────────────────────────────
function initEnvPanel() {
  loadEnvs();
  const envSelect = document.getElementById('env-select');
  if (envSelect) {
    envSelect.addEventListener('change', () => {
      state.currentEnv = envSelect.value;
      renderKVTable('env-table', objectToKVArray(state.envs[state.currentEnv] || {}));
      saveEnvs();
    });
  }
  // New env button
  const btnEnvAdd = document.getElementById('btn-env-add');
  if (btnEnvAdd) btnEnvAdd.addEventListener('click', () => {
    const name = prompt('新环境名称 (例如: staging):');
    if (name && name.trim()) {
      state.envs[name.trim()] = {};
      state.currentEnv = name.trim();
      populateEnvSelect();
      renderKVTable('env-table', []);
      saveEnvs();
    }
  });
}

function populateEnvSelect() {
  const sel = document.getElementById('env-select');
  if (!sel) return;
  sel.innerHTML = '';
  Object.keys(state.envs).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === state.currentEnv) opt.selected = true;
    sel.appendChild(opt);
  });
}

function objectToKVArray(obj) {
  return Object.entries(obj || {}).map(([key, value]) => ({ key, value, enabled: true }));
}

function loadEnvs() {
  try {
    const raw = localStorage.getItem(LS_ENVS);
    if (raw) state.envs = JSON.parse(raw);
  } catch (e) { state.envs = {}; }
  if (!state.envs || Object.keys(state.envs).length === 0) {
    state.envs = {
      dev: { base_url: 'http://localhost:3000' },
      prod: { base_url: 'https://api.example.com' },
      local: { base_url: 'http://127.0.0.1:3000' },
    };
  }
  const active = localStorage.getItem(LS_ACTIVE_ENV);
  if (active && state.envs[active]) state.currentEnv = active;
  populateEnvSelect();
  renderKVTable('env-table', objectToKVArray(state.envs[state.currentEnv] || {}));
}

function saveEnvs() {
  syncFromTables(); // capture env table first
  localStorage.setItem(LS_ENVS, JSON.stringify(state.envs));
  localStorage.setItem(LS_ACTIVE_ENV, state.currentEnv);
}

// ═════════════════════════════════════════════════════════════════
//  HISTORY STORE
// ═════════════════════════════════════════════════════════════════

function loadHistory() {
  try {
    state.history = JSON.parse(localStorage.getItem(LS_HISTORY)) || [];
  } catch (e) { state.history = []; }
}

function saveHistory() {
  const capped = state.history.slice(0, state.historyMax);
  localStorage.setItem(LS_HISTORY, JSON.stringify(capped));
}

function addHistoryEntry(snapshot) {
  // Dedupe: same method + URL → replace latest entry
  const dupIdx = state.history.findIndex(h =>
    h.method === snapshot.method && h.url === snapshot.url
  );
  if (dupIdx >= 0) {
    const pinned = state.history[dupIdx].pinned;
    state.history.splice(dupIdx, 1);
    state.history.unshift({ id: Date.now(), ...snapshot, pinned, timestamp: new Date().toISOString() });
  } else {
    state.history.unshift({ id: Date.now(), ...snapshot, pinned: false, timestamp: new Date().toISOString() });
    if (state.history.length > state.historyMax) state.history.pop();
  }
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  // Sort: pinned first, then by timestamp descending
  const sorted = [...state.history].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.id || 0) - (a.id || 0);
  });
  list.innerHTML = sorted.map(h => {
    const methodClass = h.method?.toLowerCase() || 'get';
    const shortUrl = (h.url || '').substring(0, 60) + (h.url && h.url.length > 60 ? '...' : '');
    const pinIcon = h.pinned ? 'icon/pinned.svg' : 'icon/pin.svg';
    return `<div class="history-item${h.pinned ? ' pinned' : ''}" data-id="${h.id}">
      <span class="method-badge ${methodClass}">${escHtml(h.method || 'GET')}</span>
      <span class="url-text" title="${escHtml(h.url || '')}">${escHtml(shortUrl)}</span>
      <span class="history-actions">
        <button class="pin-btn" title="置顶/取消置顶"><img src="${pinIcon}" /></button>
        <button class="del-history-btn" title="删除"><img src="icon/delete.svg" /></button>
      </span>
    </div>`;
  }).join('');

  // Click to restore
  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.pin-btn') || e.target.closest('.del-history-btn')) return;
      const id = Number(item.dataset.id);
      restoreFromHistory(id);
    });
  });
  // Pin toggle
  list.querySelectorAll('.pin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.closest('.history-item').dataset.id);
      const entry = state.history.find(h => h.id === id);
      if (entry) {
        entry.pinned = !entry.pinned;
        saveHistory();
        renderHistory();
      }
    });
  });
  // Delete single history item
  list.querySelectorAll('.del-history-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.closest('.history-item').dataset.id);
      state.history = state.history.filter(h => h.id !== id);
      saveHistory();
      renderHistory();
    });
  });
}

function restoreFromHistory(id) {
  const entry = state.history.find(h => h.id === id);
  if (!entry) return;
  // Restore to current tab
  const t = getActiveTab();
  t.method = entry.method || 'GET';
  t.url = entry.url || '';
  t.params = entry.params || [];
  t.headers = entry.headers || [];
  t.bodyType = entry.bodyType || 'none';
  t.rawContentType = entry.rawContentType || 'application/json';
  t.rawBody = entry.rawBody || '';
  t.formdataFields = entry.formdataFields || [];
  t.urlencodedFields = entry.urlencodedFields || [];
  t.binaryPath = entry.binaryPath || '';
  t.formdataMode = entry.formdataMode || 'table';
  t.formdataRaw = entry.formdataRaw || '';
  t.urlencodedMode = entry.urlencodedMode || 'table';
  t.urlencodedRaw = entry.urlencodedRaw || '';
  t.binaryMode = entry.binaryMode || 'file';
  t.binaryRaw = entry.binaryRaw || '';
  t.jsonBody = entry.jsonBody || '';
  t.authType = entry.authType || 'none';
  t.bearerToken = entry.bearerToken || '';
  t.basicUsername = entry.basicUsername || '';
  t.basicPassword = entry.basicPassword || '';
  t.apiKeyKey = entry.apiKeyKey || '';
  t.apiKeyValue = entry.apiKeyValue || '';
  t.apiKeyAddTo = entry.apiKeyAddTo || 'header';
  if (entry.currentEnv && state.envs[entry.currentEnv]) {
    state.currentEnv = entry.currentEnv;
  }
  populateUI();
  document.querySelector('.tab[data-tab="params"]')?.click();
}

function clearHistory() {
  state.history = state.history.filter(h => h.pinned);
  saveHistory();
  renderHistory();
}

/** Snapshot current UI state for history */
function takeHistorySnapshot() {
  syncFromTables();
  const t = getActiveTab();
  return {
    method: t.method, url: t.url,
    params: JSON.parse(JSON.stringify(t.params)),
    headers: JSON.parse(JSON.stringify(t.headers)),
    bodyType: t.bodyType,
    rawContentType: t.rawContentType, rawBody: t.rawBody,
    formdataFields: JSON.parse(JSON.stringify(t.formdataFields)),
    urlencodedFields: JSON.parse(JSON.stringify(t.urlencodedFields)),
    formdataMode: t.formdataMode, formdataRaw: t.formdataRaw,
    urlencodedMode: t.urlencodedMode, urlencodedRaw: t.urlencodedRaw,
    binaryPath: t.binaryPath, binaryMode: t.binaryMode, binaryRaw: t.binaryRaw,
    jsonBody: t.jsonBody,
    authType: t.authType, bearerToken: t.bearerToken,
    basicUsername: t.basicUsername, basicPassword: t.basicPassword,
    apiKeyKey: t.apiKeyKey, apiKeyValue: t.apiKeyValue, apiKeyAddTo: t.apiKeyAddTo,
    currentEnv: state.currentEnv, script: t.script,
  };
}

// ═════════════════════════════════════════════════════════════════
//  VARIABLE RESOLVER
// ═════════════════════════════════════════════════════════════════

function getActiveEnvVars() {
  syncFromTables(); // ensure env table is read
  return state.envs[state.currentEnv] || {};
}

function resolveVariables(text) {
  const vars = getActiveEnvVars();
  let result = String(text || '');
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${escapeRegex(k)}\\}\\}`, 'g'), v);
  }
  return result;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═════════════════════════════════════════════════════════════════
//  cURL CONVERTER
// ═════════════════════════════════════════════════════════════════

function buildCurlCommand() {
  syncFromTables();
  const t = getActiveTab();
  const lines = [];
  let url = t.url;
  // Query params
  const activeParams = t.params.filter(p => p.enabled && p.key);
  if (activeParams.length) {
    const qs = activeParams.map(p => encodeURIComponent(resolveVariables(p.key)) + '=' + encodeURIComponent(resolveVariables(p.value))).join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  url = resolveVariables(url);
  lines.push(`curl -X ${t.method.toUpperCase()} "${url}"`);

  // Headers
  const activeHeaders = t.headers.filter(h => h.enabled && h.key);
  activeHeaders.forEach(h => {
    const val = resolveVariables(h.value);
    lines.push(`  -H "${h.key}: ${val}"`);
  });

  // Auth
  if (t.authType === 'bearer' && t.bearerToken) {
    lines.push(`  -H "Authorization: Bearer ${resolveVariables(t.bearerToken)}"`);
  } else if (t.authType === 'basic' && t.basicUsername) {
    const u = resolveVariables(t.basicUsername);
    const p = resolveVariables(t.basicPassword);
    const encoded = btoa(u + ':' + p);
    lines.push(`  -H "Authorization: Basic ${encoded}"`);
  } else if (t.authType === 'apikey' && t.apiKeyKey) {
    if (t.apiKeyAddTo === 'header') {
      lines.push(`  -H "${t.apiKeyKey}: ${resolveVariables(t.apiKeyValue)}"`);
    } else {
      url += (url.includes('?') ? '&' : '?') + encodeURIComponent(t.apiKeyKey) + '=' + encodeURIComponent(resolveVariables(t.apiKeyValue));
      lines[0] = `curl -X ${t.method.toUpperCase()} "${url}"`; // update first line
    }
  }

  // Body
  if (t.bodyType === 'raw' && t.rawBody) {
    lines.push(`  -H "Content-Type: ${t.rawContentType}"`);
    const body = resolveVariables(t.rawBody).replace(/'/g, `'\\''`);
    lines.push(`  -d '${body}'`);
  } else if (t.bodyType === 'x-www-form-urlencoded' && t.urlencodedFields.length) {
    const form = t.urlencodedFields
      .filter(f => f.enabled && f.key)
      .map(f => encodeURIComponent(f.key) + '=' + encodeURIComponent(resolveVariables(f.value)))
      .join('&');
    if (form) lines.push(`  -d '${form}'`);
  } else if (t.bodyType === 'form-data' && t.formdataFields.length) {
    t.formdataFields.filter(f => f.enabled && f.key).forEach(f => {
      if (f.fieldType === 'file') {
        lines.push(`  -F "${f.key}=@${f.filePath}"`);
      } else {
        lines.push(`  -F "${f.key}=${resolveVariables(f.text || '')}"`);
      }
    });
  } else if (t.bodyType === 'binary' && t.binaryPath) {
    lines.push(`  --data-binary "@${t.binaryPath}"`);
  }

  return lines.join(' \\\n');
}

/** Basic cURL parser – extracts method, url, headers, data */
function parseCurlCommand(raw) {
  const result = {
    method: 'GET',
    url: '',
    headers: [],
    rawBody: '',
    bodyType: 'none',
    rawContentType: 'application/json',
  };
  const text = raw.replace(/\\\n/g, ' ').replace(/\n/g, ' ');
  // Method
  const methodMatch = text.match(/-X\s+(\w+)/i);
  if (methodMatch) result.method = methodMatch[1].toUpperCase();
  else if (text.includes('--data') || text.includes('-d ') || text.includes('-F ')) result.method = 'POST';
  // URL
  const urlMatch = text.match(/(?:curl\s+(?:-X\s+\w+\s+)?)?(?:--url\s+)?['"]?(https?:\/\/[^\s'"]+)/i);
  if (urlMatch) result.url = urlMatch[1];
  else {
    const urlMatch2 = text.match(/['"](https?:\/\/[^'"]+)['"]/);
    if (urlMatch2) result.url = urlMatch2[1];
  }
  // Headers
  const headerRe = /-H\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    const parts = m[1].split(':');
    const key = parts[0].trim();
    const value = parts.slice(1).join(':').trim();
    if (key.toLowerCase() === 'authorization') {
      if (value.startsWith('Bearer ')) {
        // Will be set in auth
      } else if (value.startsWith('Basic ')) {
        // Will be set in auth
      }
    }
    result.headers.push({ key, value, enabled: true });
  }
  // Data
  const dataMatch = text.match(/(?:--data(?:-raw|-binary)?|-d)\s+['"]([^'"]+)['"]/);
  if (dataMatch) {
    result.bodyType = 'raw';
    result.rawBody = dataMatch[1];
  }
  // Form
  const formMatch = text.match(/-F\s+['"]([^'"]+)['"]/g);
  if (formMatch) {
    result.bodyType = 'form-data';
    result.rawBody = formMatch.join('\n');
  }
  // Content-Type
  const ctHeader = result.headers.find(h => h.key.toLowerCase() === 'content-type');
  if (ctHeader) result.rawContentType = ctHeader.value;

  return result;
}

// ═════════════════════════════════════════════════════════════════
//  REQUEST SENDER (fetch)
// ═════════════════════════════════════════════════════════════════

async function sendRequest() {
  syncFromTables();
  const t = getActiveTab();
  const snapshot = takeHistorySnapshot();

  // Run pre-request script
  runPreScript(t);

  // Show loading
  const respContent = document.getElementById('resp-body-content');
  const statusEl = document.getElementById('resp-status');
  const timeEl = document.getElementById('resp-time');
  const sizeEl = document.getElementById('resp-size');
  respContent.textContent = '发送中...';
  respContent.className = 'code-view';
  statusEl.textContent = '加载中...';
  statusEl.className = 'status-badge';
  timeEl.textContent = '';
  sizeEl.textContent = '';

  // Abort previous
  if (state.aborter) state.aborter.abort();
  const controller = new AbortController();
  state.aborter = controller;

  // Build URL
  let url = t.url;
  const activeParams = t.params.filter(p => p.enabled && p.key);
  if (activeParams.length) {
    const qs = activeParams.map(p => encodeURIComponent(resolveVariables(p.key)) + '=' + encodeURIComponent(resolveVariables(p.value))).join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  url = resolveVariables(url);

  // Add API Key query param
  if (t.authType === 'apikey' && t.apiKeyAddTo === 'query' && t.apiKeyKey) {
    url += (url.includes('?') ? '&' : '?') + encodeURIComponent(t.apiKeyKey) + '=' + encodeURIComponent(resolveVariables(t.apiKeyValue));
  }

  // Build headers
  const headers = {};
  t.headers.filter(h => h.enabled && h.key).forEach(h => {
    headers[h.key] = resolveVariables(h.value);
  });

  // Auth header
  if (t.authType === 'bearer' && t.bearerToken) {
    headers['Authorization'] = 'Bearer ' + resolveVariables(t.bearerToken);
  } else if (t.authType === 'basic' && t.basicUsername) {
    const u = resolveVariables(t.basicUsername);
    const p = resolveVariables(t.basicPassword);
    headers['Authorization'] = 'Basic ' + btoa(u + ':' + p);
  } else if (t.authType === 'apikey' && t.apiKeyAddTo === 'header' && t.apiKeyKey) {
    headers[t.apiKeyKey] = resolveVariables(t.apiKeyValue);
  }

  // Build fetch options
  const opts = { method: t.method.toUpperCase(), headers, signal: controller.signal };

  const startTime = performance.now();

  // Body
  if (t.method.toUpperCase() !== 'GET' && t.method.toUpperCase() !== 'HEAD') {
    if (t.bodyType === 'raw' && t.rawBody) {
      opts.body = resolveVariables(t.rawBody);
    } else if (t.bodyType === 'json' && t.jsonBody) {
      opts.body = resolveVariables(t.jsonBody);
    } else if (t.bodyType === 'x-www-form-urlencoded') {
      if (t.urlencodedMode === 'raw' && t.urlencodedRaw) {
        opts.body = resolveVariables(t.urlencodedRaw);
      } else if (t.urlencodedFields.length) {
        const form = new URLSearchParams();
        t.urlencodedFields.filter(f => f.enabled && f.key).forEach(f => {
          form.append(f.key, resolveVariables(f.value));
        });
        opts.body = form;
      }
    } else if (t.bodyType === 'form-data') {
      if (t.formdataMode === 'raw' && t.formdataRaw) {
        opts.body = resolveVariables(t.formdataRaw);
      } else if (t.formdataFields.length) {
        const fd = new FormData();
        for (const f of t.formdataFields) {
          if (!f.enabled || !f.key) continue;
          if (f.fieldType === 'file') {
            try {
              const bytes = await tauriReadFile(f.filePath);
              const blob = new Blob([bytes]);
              const fileName = f.filePath.split(/[/\\]/).pop();
              fd.append(f.key, blob, fileName);
            } catch (e) {
              respContent.textContent = `❌ 读取文件失败: ${e}`;
              respContent.className = 'code-view';
              return;
            }
          } else {
            fd.append(f.key, resolveVariables(f.text || ''));
          }
        }
        opts.body = fd;
        delete headers['Content-Type'];
        delete headers['content-type'];
      }
    } else if (t.bodyType === 'binary') {
      if (t.binaryMode === 'raw' && t.binaryRaw) {
        opts.body = resolveVariables(t.binaryRaw);
      } else if (t.binaryPath) {
        try {
          const bytes = await tauriReadFile(t.binaryPath);
          opts.body = new Blob([bytes]);
        } catch (e) {
          respContent.textContent = `❌ 读取文件失败: ${e}`;
          respContent.className = 'code-view';
          return;
        }
      }
    }
  }

  try {
    const resp = await tauriFetch(url, opts);
    const elapsed = Math.round(performance.now() - startTime);

    // Read headers
    const responseHeaders = {};
    resp.headers.forEach((v, k) => { responseHeaders[k] = v; });
    const contentType = resp.headers.get('content-type') || '';

    // Read body
    let bodyText = '';
    let sizeBytes = 0;
    try {
      const blob = await resp.blob();
      sizeBytes = blob.size;
      if (contentType.startsWith('image/') || contentType.includes('application/pdf')) {
        bodyText = URL.createObjectURL(blob);
      } else {
        bodyText = await blob.text();
      }
    } catch (e) {
      bodyText = `[无法读取响应体: ${e.message}]`;
    }

    displayResponse({
      status: resp.status,
      statusText: resp.statusText,
      headers: responseHeaders,
      contentType,
      bodyText,
      elapsed,
      sizeBytes,
    });

    // Add to history
    addHistoryEntry(snapshot);

  } catch (err) {
    const elapsed = Math.round(performance.now() - startTime);
    if (err.name === 'AbortError') {
      displayResponse({ status: 0, statusText: '已取消', headers: {}, contentType: '', bodyText: '请求已被取消', elapsed, sizeBytes: 0 });
    } else {
      displayResponse({ status: 0, statusText: '错误', headers: {}, contentType: '', bodyText: `${err.name}: ${err.message}`, elapsed, sizeBytes: 0 });
    }
    addHistoryEntry(snapshot);
  }
}

function displayResponse(resp) {
  state.currentResponse = resp;
  const statusEl = document.getElementById('resp-status');
  const timeEl = document.getElementById('resp-time');
  const sizeEl = document.getElementById('resp-size');
  const bodyEl = document.getElementById('resp-body-content');
  const headersTable = document.getElementById('resp-headers-table');

  // Status badge
  const sc = resp.status;
  let scClass = 'status-err';
  if (sc >= 200 && sc < 300) scClass = 'status-2xx';
  else if (sc >= 300 && sc < 400) scClass = 'status-3xx';
  else if (sc >= 400 && sc < 500) scClass = 'status-4xx';
  else if (sc >= 500) scClass = 'status-5xx';

  statusEl.textContent = resp.status ? `${resp.status} ${resp.statusText}` : resp.statusText;
  statusEl.className = `status-badge ${scClass}`;
  timeEl.textContent = `${resp.elapsed}ms`;
  sizeEl.textContent = `${formatBytes(resp.sizeBytes)}`;

  // Body
  const ct = resp.contentType || '';
  bodyEl.className = 'code-view';
  if (ct.startsWith('image/')) {
    bodyEl.innerHTML = `<img src="${resp.bodyText}" style="max-width:100%;max-height:500px;" alt="响应图片" />`;
  } else if (ct.includes('application/pdf')) {
    bodyEl.innerHTML = `<embed src="${resp.bodyText}" type="application/pdf" style="width:100%;height:600px;" />`;
  } else if (ct.includes('html')) {
    bodyEl.innerHTML = '<code>' + renderHighlighted(resp.bodyText, 'html') + '</code>';
    initFoldHandler();
  } else if (ct.includes('json') || looksLikeJson(resp.bodyText)) {
    bodyEl.innerHTML = '<code>' + renderHighlighted(resp.bodyText, 'json') + '</code>';
    initFoldHandler();
  } else if (ct.includes('xml') || looksLikeXml(resp.bodyText)) {
    bodyEl.innerHTML = '<code>' + renderHighlighted(resp.bodyText, 'xml') + '</code>';
    initFoldHandler();
  } else {
    bodyEl.textContent = resp.bodyText || '(空响应)';
  }

  // Headers table
  if (headersTable) {
    headersTable.innerHTML = Object.entries(resp.headers || {}).map(([k, v]) =>
      `<div class="kv-row">
        <input type="text" class="kv-key" value="${escHtml(k)}" readonly />
        <input type="text" class="kv-value" value="${escHtml(v)}" readonly />
      </div>`
    ).join('');
  }

  // Switch to response body tab
  document.querySelector('.resp-tab[data-resp-tab="body"]')?.click();
}

function tryFormat(text, type) {
  try {
    if (type === 'json') return JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) { /* not valid, return raw */ }
  return text;
}

/** Syntax-highlight code and wrap in foldable regions */
function renderHighlighted(text, lang) {
  const formatted = tryFormat(text, lang);
  let html;
  if (lang === 'json') html = highlightJson(formatted);
  else if (lang === 'xml' || lang === 'html') html = highlightXml(formatted);
  else html = escHtml(formatted);
  return foldCode(html, lang);
}

function highlightJson(code) {
  return escHtml(code).replace(
    /("(?:\\.|[^"\\])*")\s*:/g,
    '<span class="hl-key">$1</span>:'
  ).replace(
    /:\s*("(?:\\.|[^"\\])*")/g,
    ': <span class="hl-str">$1</span>'
  ).replace(
    /:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g,
    ': <span class="hl-num">$1</span>'
  ).replace(
    /:\s*(true|false|null)/g,
    ': <span class="hl-bool">$1</span>'
  );
}

function highlightXml(code) {
  return escHtml(code).replace(
    /(&lt;\/?)([\w\-.]+)([\s\S]*?)(\/?&gt;)/g,
    (m, open, tag, attrs, close) =>
      open + '<span class="hl-tag">' + tag + '</span>' +
      attrs.replace(/([\w\-:.]+)(=)(&quot;[^&]*&quot;)/g,
        '<span class="hl-attr">$1</span>$2<span class="hl-str">$3</span>'
      ) + close
  );
}

/** Inject clickable fold buttons for JSON/XML blocks */
function foldCode(html, lang) {
  if (lang !== 'json' && lang !== 'xml' && lang !== 'html') return html;
  let depth = 0;
  const lines = html.split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openCount = (line.match(/\{|\[|&lt;\w+/g) || []).length;
    const closeCount = (line.match(/\}|\]|\/&gt;|&lt;\//g) || []).length;
    const hasOpen = /(\{|\[)$/.test(line.trim()) || /&lt;\w+[^/]*&gt;/.test(line) && !/\/&gt;/.test(line) && !/&lt;\//.test(line);
    const id = 'fold-' + i;
    if (hasOpen) {
      result.push(
        `<span class="fold-toggle" data-fold="${id}" title="折叠">收起</span>` +
        `<span id="${id}">${line}</span>`
      );
    } else {
      result.push(line);
    }
    if (closeCount > openCount && depth > 0) depth--;
    if (openCount > closeCount) depth++;
  }
  return result.join('\n');
}

/** Global click handler for fold toggles */
function initFoldHandler() {
  document.getElementById('resp-body-content').addEventListener('click', (e) => {
    const toggle = e.target.closest('.fold-toggle');
    if (!toggle) return;
    const id = toggle.dataset.fold;
    const target = document.getElementById(id);
    if (!target) return;
    const collapsed = target.classList.toggle('fold-collapsed');
    toggle.textContent = collapsed ? '展开' : '收起';
    // Collapse until next sibling at same or lower indent
    let next = target.nextElementSibling;
    while (next && !(next.classList && next.classList.contains('fold-toggle'))) {
      next.classList.toggle('fold-hidden', collapsed);
      next = next.nextElementSibling;
    }
  });
}

function looksLikeJson(text) {
  const t = (text || '').trim();
  return (t.startsWith('{') || t.startsWith('['));
}
function looksLikeXml(text) {
  return (text || '').trim().startsWith('<');
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ═════════════════════════════════════════════════════════════════
//  POPULATE UI FROM STATE
// ═════════════════════════════════════════════════════════════════

function populateUI() {
  const t = getActiveTab();
  document.getElementById('method-select').value = t.method;
  document.getElementById('url-input').value = t.url;
  renderKVTable('params-table', t.params);
  renderKVTable('headers-table', t.headers);

  // Body
  const bodyRadio = document.querySelector(`input[name="body-type"][value="${t.bodyType}"]`);
  if (bodyRadio) bodyRadio.checked = true;
  document.getElementById('raw-content-type').value = t.rawContentType;
  document.getElementById('raw-body').value = t.rawBody;
  document.getElementById('binary-path').value = t.binaryPath;
  document.getElementById('json-body').value = t.jsonBody || '';
  document.getElementById('formdata-raw').value = t.formdataRaw || '';
  document.getElementById('urlencoded-raw').value = t.urlencodedRaw || '';
  document.getElementById('binary-raw').value = t.binaryRaw || '';
  const formdataMode = document.getElementById('formdata-mode');
  if (formdataMode) formdataMode.value = t.formdataMode || 'table';
  const urlencodedMode = document.getElementById('urlencoded-mode');
  if (urlencodedMode) urlencodedMode.value = t.urlencodedMode || 'table';
  const binaryModeRadio = document.querySelector(`input[name="binary-mode"][value="${t.binaryMode || 'file'}"]`);
  if (binaryModeRadio) binaryModeRadio.checked = true;
  renderKVTable('formdata-table', t.formdataFields, true);
  renderKVTable('urlencoded-table', t.urlencodedFields);
  updateBodySubPanel();
  syncContentTypeHeader(t);

  // Auth
  const authRadio = document.querySelector(`input[name="auth-type"][value="${t.authType}"]`);
  if (authRadio) authRadio.checked = true;
  document.getElementById('bearer-token').value = t.bearerToken;
  document.getElementById('basic-username').value = t.basicUsername;
  document.getElementById('basic-password').value = t.basicPassword;
  document.getElementById('apikey-key').value = t.apiKeyKey;
  document.getElementById('apikey-value').value = t.apiKeyValue;
  document.getElementById('apikey-addto').value = t.apiKeyAddTo;
  updateAuthSubPanel();

  // Script
  const scriptEl = document.getElementById('script-body');
  if (scriptEl) scriptEl.value = t.script || '';

  // Tab bar
  renderTabBar();
}

// ── Save & Copy Response ─────────────────────────────────────────
async function saveResponse() {
  if (!state.currentResponse) return;
  try {
    const filePath = await tauriSave({
      filters: [{ name: 'All Files', extensions: ['*'] }],
      defaultPath: 'response.json',
    });
    if (filePath) {
      await tauriWriteFile(filePath, state.currentResponse.bodyText);
    }
  } catch (e) { /* cancelled */ }
}

async function copyResponse() {
  if (!state.currentResponse) return;
  try {
    await navigator.clipboard.writeText(state.currentResponse.bodyText);
  } catch (e) { /* ignore */ }
}

// ── cURL Export / Import UI ──────────────────────────────────────
function exportCurl() {
  const cmd = buildCurlCommand();
  navigator.clipboard.writeText(cmd).catch(() => { });
  // Also show briefly
  const respContent = document.getElementById('resp-body-content');
  respContent.textContent = cmd;
  respContent.className = 'code-view';
  document.querySelector('.resp-tab[data-resp-tab="body"]')?.click();
}

function importCurl() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('curl-import-text').focus();
}

function parseAndImportCurl() {
  const raw = document.getElementById('curl-import-text').value;
  const parsed = parseCurlCommand(raw);
  const t = getActiveTab();
  if (parsed.url) t.url = parsed.url;
  if (parsed.method) t.method = parsed.method;
  if (parsed.headers.length) t.headers = parsed.headers;
  if (parsed.bodyType !== 'none') t.bodyType = parsed.bodyType;
  if (parsed.rawBody) t.rawBody = parsed.rawBody;
  if (parsed.rawContentType) t.rawContentType = parsed.rawContentType;
  populateUI();
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('curl-import-text').value = '';
}

// ═════════════════════════════════════════════════════════════════
//  TAB BAR
// ═════════════════════════════════════════════════════════════════

function renderTabBar() {
  const list = document.getElementById('tab-list');
  if (!list) return;
  list.innerHTML = state.tabs.map((t, i) => {
    const shortUrl = (t.url || '(新请求)').substring(0, 30) + ((t.url || '').length > 30 ? '...' : '');
    return `<div class="req-tab${i === state.activeTab ? ' active' : ''}" data-index="${i}">
      <span class="req-tab-method">${escHtml(t.method)}</span>
      <span class="req-tab-url">${escHtml(shortUrl)}</span>
      <span class="req-tab-close" data-close="${i}">×</span>
    </div>`;
  }).join('');
}

function initTabBar() {
  const list = document.getElementById('tab-list');
  // Click tab to switch
  list.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.req-tab-close');
    const tabEl = e.target.closest('.req-tab');
    if (!tabEl) return;
    const idx = Number(tabEl.dataset.index);
    if (closeBtn) {
      closeTab(idx);
      return;
    }
    switchTab(idx);
  });
  // New tab button
  document.getElementById('btn-new-tab').addEventListener('click', () => {
    addTab();
  });
  // Script body listener
  const scriptEl = document.getElementById('script-body');
  if (scriptEl) scriptEl.addEventListener('input', () => {
    getActiveTab().script = scriptEl.value;
  });

  // Load saved tabs
  loadTabs();
}

function addTab() {
  syncFromTables();
  state.tabs.push(newTabState('GET', ''));
  switchTab(state.tabs.length - 1);
}

function switchTab(index) {
  if (index === state.activeTab || index < 0 || index >= state.tabs.length) return;
  syncFromTables(); // save current
  state.activeTab = index;
  state.currentResponse = null;
  clearResponseUI();
  populateUI();
  saveTabs();
}

function closeTab(index) {
  if (state.tabs.length <= 1) return;
  syncFromTables();
  state.tabs.splice(index, 1);
  if (state.activeTab >= state.tabs.length) state.activeTab = state.tabs.length - 1;
  if (state.activeTab > index && state.activeTab > 0) state.activeTab--;
  populateUI();
  saveTabs();
}

function clearResponseUI() {
  const statusEl = document.getElementById('resp-status');
  const timeEl = document.getElementById('resp-time');
  const sizeEl = document.getElementById('resp-size');
  const bodyEl = document.getElementById('resp-body-content');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'status-badge'; }
  if (timeEl) timeEl.textContent = '';
  if (sizeEl) sizeEl.textContent = '';
  if (bodyEl) bodyEl.textContent = '点击 Send 发送请求';
}

function saveTabs() {
  const slim = state.tabs.map(t => ({
    method: t.method, url: t.url,
    params: t.params, headers: t.headers,
    bodyType: t.bodyType, rawContentType: t.rawContentType,
    rawBody: t.rawBody, formdataFields: t.formdataFields,
    urlencodedFields: t.urlencodedFields,
    formdataMode: t.formdataMode, formdataRaw: t.formdataRaw,
    urlencodedMode: t.urlencodedMode, urlencodedRaw: t.urlencodedRaw,
    binaryPath: t.binaryPath, binaryMode: t.binaryMode, binaryRaw: t.binaryRaw,
    jsonBody: t.jsonBody,
    authType: t.authType, bearerToken: t.bearerToken,
    basicUsername: t.basicUsername, basicPassword: t.basicPassword,
    apiKeyKey: t.apiKeyKey, apiKeyValue: t.apiKeyValue, apiKeyAddTo: t.apiKeyAddTo,
    script: t.script,
  }));
  localStorage.setItem(LS_TABS, JSON.stringify(slim));
  localStorage.setItem(LS_ACTIVE_TAB, state.activeTab);
}

function loadTabs() {
  try {
    const raw = localStorage.getItem(LS_TABS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (arr.length) {
        state.tabs = arr.map(item => ({ ...newTabState(item.method, item.url), ...item }));
        state.activeTab = Number(localStorage.getItem(LS_ACTIVE_TAB)) || 0;
        if (state.activeTab >= state.tabs.length) state.activeTab = 0;
      }
    }
  } catch (e) { /* ignore */ }
}

// ═════════════════════════════════════════════════════════════════
//  PRE-REQUEST SCRIPT
// ═════════════════════════════════════════════════════════════════

function runPreScript(t) {
  const code = (t.script || '').trim();
  if (!code) return;
  const env = getActiveEnvVars();
  try {
    const fn = new Function('env', 'timestamp', 'random', 'url', 'method', code);
    fn(env, Date.now(), Math.random().toString(36).slice(2), resolveVariables(t.url), t.method);
    // Write back script-modified env vars
    state.envs[state.currentEnv] = env;
    saveEnvs();
  } catch (e) {
    console.error('Pre-request script error:', e);
  }
}

// ═════════════════════════════════════════════════════════════════
//  INIT – DOMContentLoaded
// ═════════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  // DOM refs helper
  $ = (sel) => document.querySelector(sel);

  // Init subsystems
  initTabs();
  initBodyPanel();
  initAuthPanel();
  initEnvPanel();
  initTabBar();
  loadHistory();
  renderHistory();

  // Method select
  document.getElementById('method-select').addEventListener('change', (e) => {
    getActiveTab().method = e.target.value;
  });

  // URL input
  document.getElementById('url-input').addEventListener('input', (e) => {
    getActiveTab().url = e.target.value;
  });

  // Send button
  document.getElementById('btn-send').addEventListener('click', sendRequest);

  // Ctrl+Enter to send
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendRequest();
    }
  });

  // Add row buttons
  document.querySelectorAll('.btn-add-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      const map = {
        params: ['params-table', false],
        headers: ['headers-table', false],
        formdata: ['formdata-table', true],
        urlencoded: ['urlencoded-table', false],
        env: ['env-table', false],
      };
      const [id, showFile] = map[target] || [target, false];
      addKVRow(id, showFile);
    });
  });

  // Quick headers — loaded from src/headers.json
  fetch('headers.json')
    .then(r => r.json())
    .then(list => {
      const container = document.getElementById('quick-headers');
      if (!container) return;
      list.forEach(item => {
        const btn = document.createElement('button');
        btn.textContent = item.label;
        btn.addEventListener('click', () => {
          document.getElementById('headers-table').appendChild(
            createKVRow('headers-table', { key: item.key, value: item.value, enabled: true }, false)
          );
          syncFromTables();
        });
        container.appendChild(btn);
      });
    })
    .catch(() => { });

  // Params bulk import
  document.getElementById('params-bulk').addEventListener('change', (e) => {
    const raw = e.target.value.trim();
    if (!raw) return;
    const pairs = raw.split('&').map(p => {
      const [key, val] = p.split('=');
      return { key: decodeURIComponent(key || ''), value: decodeURIComponent(val || ''), enabled: true };
    });
    pairs.forEach(p => {
      document.getElementById('params-table').appendChild(createKVRow('params-table', p, false));
    });
    syncFromTables();
    e.target.value = '';
  });

  // cURL export
  document.getElementById('btn-curl-export').addEventListener('click', exportCurl);
  // cURL import
  document.getElementById('btn-curl-import').addEventListener('click', importCurl);
  document.getElementById('btn-curl-parse').addEventListener('click', parseAndImportCurl);
  document.getElementById('btn-modal-close').addEventListener('click', () => {
    document.getElementById('modal-overlay').classList.add('hidden');
  });
  // Click overlay to close
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) document.getElementById('modal-overlay').classList.add('hidden');
  });

  // Save / Copy response
  document.getElementById('btn-save-response').addEventListener('click', saveResponse);
  document.getElementById('btn-copy-response').addEventListener('click', copyResponse);

  // Clear history
  document.getElementById('btn-clear-history').addEventListener('click', () => {
    if (confirm('确认清空所有历史记录？')) clearHistory();
  });

  // ── Theme toggle ──────────────────────────────────────────────────
  const LS_THEME = 'httpclient_theme';
  const html = document.documentElement;
  // Restore
  const saved = localStorage.getItem(LS_THEME) || 'light';
  html.setAttribute('data-theme', saved);
  updateThemeBtn(saved);

  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem(LS_THEME, next);
    updateThemeBtn(next);
  });

  function updateThemeBtn(theme) {
    const btn = document.getElementById('btn-theme');
    btn.innerHTML = `<img src="icon/${theme === 'dark' ? 'light-mode' : 'dark-mode'}.svg" />`;
  }

  // ── Resizer: split request / response ────────────────────────────
  const reqSec = document.getElementById('request-section');
  const resSec = document.getElementById('response-section');
  const resizer = document.getElementById('resizer');
  const LS_SPLIT = 'httpclient_split';
  const savedPct = parseFloat(localStorage.getItem(LS_SPLIT)) || 50;
  let dragging = false;
  applySplit(savedPct);
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const main = document.getElementById('main');
    const rect = main.getBoundingClientRect();
    const pct = ((e.clientY - rect.top) / rect.height) * 100;
    applySplit(Math.max(20, Math.min(80, pct)));
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  function applySplit(pct) {
    reqSec.style.flex = `${pct}`;
    resSec.style.flex = `${100 - pct}`;
    if (!dragging) localStorage.setItem(LS_SPLIT, pct.toFixed(0));
  }
  // Save on mouseup
  document.addEventListener('mouseup', () => {
    if (dragging) return;
    const pct = parseFloat(reqSec.style.flex);
    if (!isNaN(pct)) localStorage.setItem(LS_SPLIT, pct.toFixed(0));
  });

  // Initial render
  populateUI();
});
