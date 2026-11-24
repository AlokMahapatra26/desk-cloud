'use strict';

const state = {
  authEnabled: true,
  authenticated: false,
  readonly: false,
  chunkSizeBytes: 20 * 1024 * 1024,
  root: '0',
  path: '',
  search: '',
  type: 'all',
  sort: 'name',
  order: 'asc',
  page: 1,
  limit: 100,
  view: localStorage.getItem('storage_view') || 'list',
  roots: [],
};

const el = (id) => document.getElementById(id);

// Clean Lucide-style SVG icon pack (1.75px stroke, zero emojis)
const ICONS = {
  folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  video: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>',
  audio: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  image: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  doc: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  file: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  rename: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  grid: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  list: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  arrowUp: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
  arrowDown: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
  globe: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  chevronRight: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
};

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function createIconBadge(item) {
  const span = document.createElement('span');
  const cat = item.isDir ? 'folder' : item.category;
  span.className = `item-icon icon-${cat}`;
  span.innerHTML = ICONS[cat] || ICONS.file;
  return span;
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin();
    throw new Error(data.error || 'Unauthorized');
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function showLogin() {
  el('login-view').classList.remove('hidden');
  el('app-view').classList.add('hidden');
  el('login-password').focus();
}

function showApp() {
  el('login-view').classList.add('hidden');
  el('app-view').classList.remove('hidden');
  el('logout-btn').classList.toggle('hidden', !state.authEnabled);
  el('readonly-badge').classList.toggle('hidden', !state.readonly);
  el('tunnel-btn').classList.toggle('hidden', state.readonly);
  el('roots-btn').classList.toggle('hidden', state.readonly);
  el('upload-btn').classList.toggle('hidden', state.readonly);
  el('mkdir-btn').classList.toggle('hidden', state.readonly);
}

async function init() {
  const status = await apiJson('/api/auth/status');
  state.authEnabled = status.authEnabled;
  state.authenticated = status.authenticated;
  state.readonly = status.readonly;
  state.chunkSizeBytes = status.chunkSizeBytes || state.chunkSizeBytes;

  if (state.authEnabled && !state.authenticated) {
    showLogin();
  } else {
    showApp();
    await Promise.all([loadDirectory(), refreshTunnelStatus()]);
  }
}

async function loadDirectory() {
  const params = new URLSearchParams({
    root: state.root,
    path: state.path,
    search: state.search,
    type: state.type,
    sort: state.sort,
    order: state.order,
    page: String(state.page),
    limit: String(state.limit),
  });

  const data = await apiJson(`/api/list?${params.toString()}`);
  state.roots = data.roots || [];
  if (data.root) {
    state.root = data.root.id;
  }
  state.page = data.page;

  renderRoots();
  renderBreadcrumbs(data.breadcrumbs);
  renderFiles(data.items);
  renderPagination(data);
}

function renderRoots() {
  const select = el('root-select');
  if (state.roots.length <= 1) {
    select.classList.add('hidden');
    return;
  }
  select.classList.remove('hidden');
  select.innerHTML = '';
  for (const r of state.roots) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name;
    if (r.id === state.root) opt.selected = true;
    select.appendChild(opt);
  }
}

function renderBreadcrumbs(crumbs) {
  const nav = el('breadcrumbs');
  nav.innerHTML = '';
  crumbs.forEach((c, idx) => {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'muted';
      sep.style.display = 'inline-flex';
      sep.innerHTML = ICONS.chevronRight;
      nav.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'crumb';
    btn.textContent = c.name;
    btn.onclick = () => {
      state.path = c.path;
      state.page = 1;
      loadDirectory();
    };
    nav.appendChild(btn);
  });
}

function renderPagination(data) {
  const stats = el('item-stats');
  stats.textContent = `${data.total} item${data.total === 1 ? '' : 's'}`;

  const pag = el('pagination');
  if (data.totalPages <= 1) {
    pag.classList.add('hidden');
    return;
  }
  pag.classList.remove('hidden');
  el('page-info').textContent = `Page ${data.page} of ${data.totalPages}`;
  el('prev-page').disabled = data.page <= 1;
  el('next-page').disabled = data.page >= data.totalPages;
}

function buildFileUrl(endpoint, itemPath) {
  const p = new URLSearchParams({ root: state.root, path: itemPath });
  return `${endpoint}?${p.toString()}`;
}

function renderFiles(items) {
  const container = el('file-container');
  container.innerHTML = '';
  container.className = state.view === 'grid' ? 'file-grid' : 'file-list';
  el('view-btn').innerHTML = state.view === 'grid' ? ICONS.list : ICONS.grid;
  el('view-btn').title = state.view === 'grid' ? 'Switch to List view' : 'Switch to Grid view';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    if (state.roots.length === 0) {
      empty.innerHTML = '<p>No folders or drives are shared yet.</p>';
      if (!state.readonly) {
        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-primary';
        addBtn.textContent = 'Add Folder or Drive';
        addBtn.onclick = openRootsModal;
        empty.appendChild(addBtn);
      }
    } else {
      empty.textContent = state.search ? 'No matching files found.' : 'This folder is empty.';
    }
    container.appendChild(empty);
    return;
  }

  if (state.view === 'list') {
    const header = document.createElement('div');
    header.className = 'file-header';
    header.innerHTML = `
      <span></span>
      <span>Name</span>
      <span class="col-size">Size</span>
      <span class="col-date">Modified</span>
      <span></span>
    `;
    container.appendChild(header);
  }

  for (const item of items) {
    if (state.view === 'grid') {
      const card = document.createElement('div');
      card.className = 'grid-card';

      const top = document.createElement('div');
      top.className = 'grid-top';

      const icon = createIconBadge(item);
      icon.onclick = () => openItem(item);

      const actions = createActionButtons(item);
      top.append(icon, actions);

      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = item.name;
      name.title = item.name;
      name.onclick = () => openItem(item);

      const meta = document.createElement('div');
      meta.className = 'grid-meta';
      meta.innerHTML = `<span>${item.isDir ? 'Folder' : formatBytes(item.size)}</span><span>${formatDate(item.mtime)}</span>`;

      card.append(top, name, meta);
      container.appendChild(card);
    } else {
      const row = document.createElement('div');
      row.className = 'file-row';

      const icon = createIconBadge(item);
      icon.onclick = () => openItem(item);

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = item.name;
      name.title = item.name;
      name.onclick = () => openItem(item);

      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = item.isDir ? '—' : formatBytes(item.size);

      const date = document.createElement('span');
      date.className = 'file-date';
      date.textContent = formatDate(item.mtime);

      const actions = createActionButtons(item);
      row.append(icon, name, size, date, actions);
      container.appendChild(row);
    }
  }
}

function createActionButtons(item) {
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  if (!item.isDir) {
    const dl = document.createElement('a');
    dl.className = 'btn btn-ghost icon-only small-btn';
    dl.href = buildFileUrl('/api/download', item.path);
    dl.download = item.name;
    dl.innerHTML = ICONS.download;
    dl.title = 'Download';
    wrap.appendChild(dl);
  }

  if (!state.readonly) {
    const ren = document.createElement('button');
    ren.className = 'btn btn-ghost icon-only small-btn';
    ren.innerHTML = ICONS.rename;
    ren.title = 'Rename';
    ren.onclick = () => handleRename(item);

    const del = document.createElement('button');
    del.className = 'btn btn-ghost btn-danger icon-only small-btn';
    del.innerHTML = ICONS.trash;
    del.title = 'Delete';
    del.onclick = () => handleDelete(item);

    wrap.append(ren, del);
  }

  return wrap;
}

function openItem(item) {
  if (item.isDir) {
    state.path = item.path;
    state.page = 1;
    loadDirectory();
    return;
  }
  openPreview(item);
}

async function openPreview(item) {
  const modal = el('preview-modal');
  const body = el('preview-body');
  const title = el('preview-title');
  const dl = el('preview-download');
  const copyBtn = el('copy-stream-btn');

  const streamUrl = buildFileUrl('/api/stream', item.path);
  const downloadUrl = buildFileUrl('/api/download', item.path);

  title.textContent = item.name;
  dl.href = downloadUrl;
  dl.download = item.name;
  body.innerHTML = '';
  copyBtn.classList.add('hidden');
  modal.classList.remove('hidden');

  if (item.category === 'video') {
    copyBtn.classList.remove('hidden');
    copyBtn.onclick = async () => {
      const fullUrl = new URL(streamUrl, window.location.origin).toString();
      await navigator.clipboard.writeText(fullUrl).catch(() => {});
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy Stream URL'; }, 1500);
    };
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.src = streamUrl;
    body.appendChild(video);
  } else if (item.category === 'audio') {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.autoplay = true;
    audio.src = streamUrl;
    body.appendChild(audio);
  } else if (item.category === 'image') {
    const img = document.createElement('img');
    img.src = streamUrl;
    img.alt = item.name;
    body.appendChild(img);
  } else if (item.name.toLowerCase().endsWith('.pdf')) {
    const iframe = document.createElement('iframe');
    iframe.src = streamUrl;
    body.appendChild(iframe);
  } else if (item.category === 'doc' && item.size <= 2 * 1024 * 1024) {
    const pre = document.createElement('pre');
    pre.textContent = 'Loading...';
    body.appendChild(pre);
    try {
      const res = await fetch(streamUrl);
      pre.textContent = await res.text();
    } catch {
      pre.textContent = 'Failed to load preview.';
    }
  } else {
    const msg = document.createElement('p');
    msg.className = 'muted small';
    msg.textContent = `No inline preview for this file type (${formatBytes(item.size)}).`;
    body.appendChild(msg);
  }
}

function closePreview() {
  el('preview-modal').classList.add('hidden');
  el('preview-body').innerHTML = '';
}

async function handleRename(item) {
  const newName = prompt('Enter new name:', item.name);
  if (!newName || newName === item.name) return;
  try {
    await apiJson('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: state.root, path: item.path, newName }),
    });
    await loadDirectory();
  } catch (err) {
    alert(err.message);
  }
}

async function handleDelete(item) {
  if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
  try {
    await apiJson('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: state.root, path: item.path }),
    });
    await loadDirectory();
  } catch (err) {
    alert(err.message);
  }
}

// --- Chunked File Uploads ---

async function uploadFiles(fileList) {
  if (state.readonly || !fileList.length) return;
  el('upload-drawer').classList.remove('hidden');

  for (const file of fileList) {
    await uploadSingleFile(file);
  }
  await loadDirectory();
}

async function uploadSingleFile(file) {
  const chunkSize = state.chunkSizeBytes;
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

  const row = document.createElement('div');
  row.className = 'upload-item';
  row.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;">
      <span class="truncate">${file.name}</span>
      <span class="muted pct">0%</span>
    </div>
    <div class="progress-bar"><div class="progress-fill"></div></div>
  `;
  el('upload-list').prepend(row);
  const pctEl = row.querySelector('.pct');
  const fillEl = row.querySelector('.progress-fill');

  let uploadId = null;
  try {
    const initRes = await apiJson('/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: state.root,
        path: state.path,
        filename: file.name,
        totalChunks,
        totalSize: file.size,
      }),
    });
    uploadId = initRes.uploadId;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const blob = file.slice(start, end);

      const res = await fetch(
        `/api/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${i}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Chunk upload failed');
      }
      const pct = Math.round(((i + 1) / totalChunks) * 100);
      pctEl.textContent = `${pct}%`;
      fillEl.style.width = `${pct}%`;
    }

    await apiJson('/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    pctEl.textContent = 'Done';
  } catch (err) {
    pctEl.textContent = 'Failed';
    pctEl.style.color = '#f87171';
    if (uploadId) {
      await fetch('/api/upload/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      }).catch(() => {});
    }
    alert(`Upload failed for ${file.name}: ${err.message}`);
  }
}

// --- Event Listeners ---

el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = el('login-error');
  errEl.classList.add('hidden');
  try {
    await apiJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: el('login-password').value }),
    });
    el('login-password').value = '';
    state.authenticated = true;
    showApp();
    await Promise.all([loadDirectory(), refreshTunnelStatus()]);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

el('logout-btn').addEventListener('click', async () => {
  await apiJson('/api/auth/logout', { method: 'POST' });
  state.authenticated = false;
  showLogin();
});

el('root-select').addEventListener('change', (e) => {
  state.root = e.target.value;
  state.path = '';
  state.page = 1;
  loadDirectory();
});

let searchTimer = null;
el('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    state.page = 1;
    loadDirectory();
  }, 220);
});

el('type-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  document.querySelectorAll('#type-filters .seg-btn').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  state.type = btn.dataset.type;
  state.page = 1;
  loadDirectory();
});

el('sort-select').addEventListener('change', (e) => {
  state.sort = e.target.value;
  state.page = 1;
  loadDirectory();
});

el('order-btn').addEventListener('click', () => {
  state.order = state.order === 'asc' ? 'desc' : 'asc';
  el('order-btn').innerHTML = state.order === 'asc' ? ICONS.arrowUp : ICONS.arrowDown;
  state.page = 1;
  loadDirectory();
});

el('view-btn').addEventListener('click', () => {
  state.view = state.view === 'list' ? 'grid' : 'list';
  localStorage.setItem('storage_view', state.view);
  loadDirectory();
});

el('prev-page').addEventListener('click', () => {
  if (state.page > 1) {
    state.page -= 1;
    loadDirectory();
  }
});

el('next-page').addEventListener('click', () => {
  state.page += 1;
  loadDirectory();
});

el('mkdir-btn').addEventListener('click', async () => {
  const name = prompt('New folder name:');
  if (!name) return;
  try {
    await apiJson('/api/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: state.root, path: state.path, name }),
    });
    await loadDirectory();
  } catch (err) {
    alert(err.message);
  }
});

el('upload-btn').addEventListener('click', () => el('file-input').click());
el('file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  uploadFiles(files);
});

el('close-uploads').addEventListener('click', () => {
  el('upload-drawer').classList.add('hidden');
});

// --- Shared Folders / Drives Manager ---

let sysBrowseState = { currentPath: '', parentPath: null };

async function openRootsModal() {
  if (state.readonly) return;
  el('roots-modal').classList.remove('hidden');
  await Promise.all([refreshSharedRootsList(), loadSystemDirs('')]);
}

function closeRootsModal() {
  el('roots-modal').classList.add('hidden');
}

async function refreshSharedRootsList() {
  const data = await apiJson('/api/roots');
  state.roots = data.roots || [];
  const list = el('shared-roots-list');
  list.innerHTML = '';

  if (state.roots.length === 0) {
    list.innerHTML = '<div class="root-row muted small">No folders shared yet. Pick one below.</div>';
    return;
  }

  for (const r of state.roots) {
    const row = document.createElement('div');
    row.className = 'root-row';

    const info = document.createElement('div');
    info.className = 'root-info';
    info.innerHTML = `<strong class="truncate">${r.name}</strong><span class="muted small truncate" style="display:block;">${r.path}</span>`;

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.style.opacity = '1';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-secondary small-btn';
    openBtn.textContent = 'Open';
    openBtn.onclick = () => {
      state.root = r.id;
      state.path = '';
      state.page = 1;
      closeRootsModal();
      loadDirectory();
    };

    const rmBtn = document.createElement('button');
    rmBtn.className = 'btn btn-ghost btn-danger small-btn';
    rmBtn.textContent = 'Remove';
    rmBtn.onclick = () => removeSharedRoot(r.id);

    actions.append(openBtn, rmBtn);
    row.append(info, actions);
    list.appendChild(row);
  }
}

async function loadSystemDirs(dirPath) {
  const params = new URLSearchParams();
  if (dirPath) params.set('path', dirPath);
  const data = await apiJson(`/api/system/browse?${params.toString()}`);
  sysBrowseState = data;

  el('sys-current-path').textContent = data.currentPath || 'Drives & Quick Locations';
  el('sys-up-btn').disabled = data.parentPath === null;
  el('sys-share-current-btn').classList.toggle('hidden', !data.currentPath);

  const list = el('sys-dir-list');
  list.innerHTML = '';

  if (!data.directories || data.directories.length === 0) {
    list.innerHTML = '<div class="sys-dir-row muted small">No subfolders here.</div>';
    return;
  }

  for (const dir of data.directories) {
    const row = document.createElement('div');
    row.className = 'sys-dir-row';

    const nameBtn = document.createElement('span');
    nameBtn.className = 'sys-dir-name';
    nameBtn.innerHTML = `<span class="item-icon icon-folder" style="width:22px;height:22px;border-radius:5px;">${ICONS.folder}</span><span class="truncate">${dir.name}</span>`;
    nameBtn.title = dir.path;
    nameBtn.onclick = () => loadSystemDirs(dir.path);

    const shareBtn = document.createElement('button');
    shareBtn.className = 'btn btn-secondary small-btn';
    shareBtn.textContent = 'Share';
    shareBtn.onclick = () => addSharedRoot(dir.path);

    row.append(nameBtn, shareBtn);
    list.appendChild(row);
  }
}

async function addSharedRoot(targetPath, customName = '') {
  try {
    const res = await apiJson('/api/roots/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath, name: customName }),
    });
    state.roots = res.roots || [];
    if (res.root) state.root = res.root.id;
    state.path = '';
    state.page = 1;
    el('root-path-input').value = '';
    el('root-name-input').value = '';
    await refreshSharedRootsList();
    await loadDirectory();
  } catch (err) {
    alert(err.message);
  }
}

async function removeSharedRoot(id) {
  try {
    const res = await apiJson('/api/roots/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    state.roots = res.roots || [];
    if (state.root === id) {
      state.root = state.roots[0]?.id || '0';
      state.path = '';
      state.page = 1;
    }
    await refreshSharedRootsList();
    await loadDirectory();
  } catch (err) {
    alert(err.message);
  }
}

el('roots-btn').addEventListener('click', openRootsModal);
el('roots-close').addEventListener('click', closeRootsModal);
document.querySelector('#roots-modal .modal-backdrop').addEventListener('click', closeRootsModal);
el('sys-up-btn').addEventListener('click', () => {
  if (sysBrowseState.parentPath !== null) {
    loadSystemDirs(sysBrowseState.parentPath);
  }
});
el('sys-share-current-btn').addEventListener('click', () => {
  if (sysBrowseState.currentPath) {
    addSharedRoot(sysBrowseState.currentPath);
  }
});
el('add-root-form').addEventListener('submit', (e) => {
  e.preventDefault();
  addSharedRoot(el('root-path-input').value, el('root-name-input').value);
});

// --- Public Cloudflare Tunnel Controls ---

function renderTunnelStatus(st) {
  const btn = el('tunnel-btn');
  const banner = el('tunnel-banner');
  const urlLink = el('tunnel-url');

  if (st.status === 'running' && st.url) {
    btn.classList.add('hidden');
    banner.classList.remove('hidden');
    urlLink.href = st.url;
    urlLink.textContent = st.url;
  } else if (st.status === 'starting') {
    banner.classList.add('hidden');
    if (!state.readonly) btn.classList.remove('hidden');
    btn.disabled = true;
    btn.innerHTML = `${ICONS.globe}<span>Starting...</span>`;
  } else {
    banner.classList.add('hidden');
    if (!state.readonly) btn.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = `${ICONS.globe}<span>Go Public</span>`;
  }
}

async function refreshTunnelStatus() {
  try {
    const st = await apiJson('/api/tunnel/status');
    renderTunnelStatus(st);
  } catch {
    // Ignore if unauthenticated
  }
}

el('tunnel-btn').addEventListener('click', async () => {
  renderTunnelStatus({ status: 'starting' });
  try {
    const st = await apiJson('/api/tunnel/start', { method: 'POST' });
    renderTunnelStatus(st);
  } catch (err) {
    renderTunnelStatus({ status: 'stopped' });
    alert(`Could not start Cloudflare Tunnel: ${err.message}`);
  }
});

el('tunnel-stop-btn').addEventListener('click', async () => {
  try {
    const st = await apiJson('/api/tunnel/stop', { method: 'POST' });
    renderTunnelStatus(st);
  } catch (err) {
    alert(err.message);
  }
});

el('tunnel-copy-btn').addEventListener('click', async () => {
  const url = el('tunnel-url').textContent;
  await navigator.clipboard.writeText(url).catch(() => {});
  const span = el('tunnel-copy-btn').querySelector('span');
  if (span) {
    span.textContent = 'Copied';
    setTimeout(() => { span.textContent = 'Copy'; }, 1500);
  }
});

el('preview-close').addEventListener('click', closePreview);
document.querySelector('#preview-modal .modal-backdrop').addEventListener('click', closePreview);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePreview();
    closeRootsModal();
  }
});

// Drag & Drop support
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (state.readonly || (!state.authenticated && state.authEnabled)) return;
  e.preventDefault();
  dragCounter++;
  el('drop-overlay').classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) el('drop-overlay').classList.add('hidden');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  el('drop-overlay').classList.add('hidden');
  const files = Array.from(e.dataTransfer?.files || []);
  uploadFiles(files);
});

init().catch((err) => {
  console.error(err);
});
