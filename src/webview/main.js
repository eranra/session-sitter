// Webview main script
// Runs inside the VS Code WebView panel — no build step, plain vanilla JS.

(function () {
  'use strict';

  const vscodeApi = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────

  /** @type {Array<{sessionId: string, projectName: string, title: string, updatedAt: string, status: string}>} */
  let sessions = [];

  /** @type {Array<{sessionId: string, projectName: string, title: string, updatedAt: string, status: string}>} */
  let historySessions = [];

  // Both sections' initial open/closed state comes from the markup the host rendered — it holds
  // what you last left them at. Seeded in init() from the toggle's aria-expanded; the values here
  // only matter for the moment before that, and match the host's own defaults.
  let historyOpen = false;

  /** @type {string | null} — the session the host reports you are currently in, or null */
  let currentSessionId = null;

  /** @type {string} — id of the active sort order; the extension host owns the real value */
  let sortMode = 'recent';

  /** @type {Array<{id: string, label: string, description: string, stable: boolean}>} */
  let sortModes = [];

  /** @type {Array<{peer: string, reachable: boolean, error?: string, sessionCount?: number}>} */
  let peerStatuses = [];

  /** @type {Array<object>} — supervision activity feed (newest first) */
  let activityItems = [];
  let activityOpen = true;

  /** @type {string} — where decision cards go; 'stub' (a file) unless the host says otherwise */
  let messagingChannel = 'stub';
  /** @type {string} — `<stateDir>/notifications`, for naming where a stub card was written */
  let notificationsDir = '';

  /** @type {string | null} — sessionId whose preview we've requested (hover or "Show details") */
  let pendingPreviewSessionId = null;

  /** @type {HTMLElement | null} — row element to anchor the preview against when it arrives */
  let pendingPreviewAnchor = null;

  /** @type {HTMLElement | null} — visible context menu element, or null */
  let contextMenuEl = null;

  /** @type {ReturnType<typeof setTimeout> | null} — debounce timer for the hover preview */
  let previewTimer = null;

  // ── DOM References ────────────────────────────────────────────────────────

  let tabStrip;
  let historyToggle;
  let historyPanel;
  let previewEl;
  let activityToggle;
  let activityPanel;
  let sortBtn;

  /** @type {HTMLElement | null} — visible sort menu element, or null */
  let sortMenuEl = null;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * @param {string} isoString
   * @returns {string}
   */
  function formatRelativeTime(isoString) {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    if (isNaN(then)) { return ''; }
    const diffSec = Math.floor((now - then) / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr  = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr  / 24);
    if (diffSec < 60)  { return 'just now'; }
    if (diffMin < 60)  { return diffMin === 1 ? '1 minute ago' : `${diffMin} minutes ago`; }
    if (diffHr  < 24)  { return diffHr  === 1 ? '1 hour ago'   : `${diffHr} hours ago`; }
    if (diffDay < 30)  { return diffDay === 1 ? '1 day ago'    : `${diffDay} days ago`; }
    return new Date(isoString).toLocaleDateString();
  }

  /**
   * @param {string} projectPath
   * @param {Array<{role: string, text: string, timestamp?: string}>} exchanges
   * @param {HTMLElement} anchorEl
   * @param {string} assistantName
   */
  function showPreview(projectPath, exchanges, anchorEl, assistantName) {
    if (!previewEl) { return; }

    previewEl.innerHTML = '';

    if (projectPath) {
      const pathEl = document.createElement('div');
      pathEl.className = 'preview-path';
      pathEl.textContent = projectPath;
      previewEl.appendChild(pathEl);
    }

    exchanges.forEach(function (exchange) {
      const exchangeEl = document.createElement('div');
      exchangeEl.className = 'preview-exchange';

      const metaEl = document.createElement('div');
      metaEl.className = 'preview-meta';

      const roleEl = document.createElement('span');
      roleEl.className = 'preview-role ' +
        (exchange.role === 'user' ? 'preview-role-user' : 'preview-role-assistant');
      roleEl.textContent = exchange.role === 'user' ? 'You' : (assistantName || 'Claude');
      metaEl.appendChild(roleEl);

      if (exchange.timestamp) {
        const timeEl = document.createElement('span');
        timeEl.className = 'preview-time';
        timeEl.textContent = formatRelativeTime(exchange.timestamp);
        metaEl.appendChild(timeEl);
      }

      const textEl = document.createElement('div');
      textEl.className = 'preview-text';
      textEl.textContent = exchange.text;

      exchangeEl.appendChild(metaEl);
      exchangeEl.appendChild(textEl);
      previewEl.appendChild(exchangeEl);
    });

    // Measure off-screen before placing
    previewEl.style.top = '-9999px';
    previewEl.style.left = '-9999px';
    previewEl.hidden = false;

    const rect = anchorEl.getBoundingClientRect();
    const cardHeight = previewEl.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;

    previewEl.style.left = rect.left + 'px';
    if (spaceBelow >= cardHeight + 4) {
      previewEl.style.top = (rect.bottom + 4) + 'px';
    } else {
      previewEl.style.top = Math.max(4, rect.top - cardHeight - 4) + 'px';
    }
  }

  function hidePreview() {
    if (!previewEl) { return; }
    previewEl.hidden = true;
    previewEl.innerHTML = '';
    pendingPreviewSessionId = null;
    pendingPreviewAnchor = null;
  }

  /**
   * Request a preview after a short hover delay, anchored to the given row.
   * The preview only renders if the cursor is still on the same row when the
   * data arrives (see the 'sessionPreview' handler): a mouseleave clears the
   * pending id, so a stale response is dropped instead of flashing on screen.
   * @param {object} session
   * @param {HTMLElement} anchorEl
   */
  function scheduleHoverPreview(session, anchorEl) {
    // Don't compete with an open menu for screen space.
    if (contextMenuEl || sortMenuEl) { return; }
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      pendingPreviewSessionId = session.sessionId;
      pendingPreviewAnchor = anchorEl;
      vscodeApi.postMessage({ type: 'getSessionPreview', sessionId: session.sessionId });
    }, 250);
  }

  function cancelHoverPreview() {
    clearTimeout(previewTimer);
    previewTimer = null;
    hidePreview();
  }

  // ── Context menu ──────────────────────────────────────────────────────────

  function closeContextMenu() {
    if (contextMenuEl) {
      // Clean up any open submenus first.
      document.querySelectorAll('.session-context-menu--sub').forEach(function (s) { s.remove(); });
      contextMenuEl.remove();
      contextMenuEl = null;
    }
  }

  /**
   * Render a submenu adjacent to a parent menu-item button. Returns the
   * submenu element (already inserted into the DOM).
   * @param {HTMLElement} parentBtn
   * @param {Array<{label: string, action: Function}>} items
   */
  function renderSubmenu(parentBtn, items) {
    const sub = document.createElement('div');
    sub.className = 'session-context-menu session-context-menu--sub';
    sub.setAttribute('role', 'menu');

    items.forEach(function (subItem) {
      const btn = document.createElement('button');
      btn.className = 'session-context-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.type = 'button';
      btn.textContent = subItem.label;
      btn.addEventListener('click', function () {
        subItem.action();
        closeContextMenu();
      });
      btn.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft' || event.key === 'Escape') {
          event.preventDefault();
          sub.remove();
          parentBtn.focus();
        }
      });
      sub.appendChild(btn);
    });

    document.body.appendChild(sub);
    const parentRect = parentBtn.getBoundingClientRect();
    const subRect = sub.getBoundingClientRect();
    let left = parentRect.right;
    if (left + subRect.width > window.innerWidth - 4) {
      left = Math.max(4, parentRect.left - subRect.width);
    }
    sub.style.left = left + 'px';
    sub.style.top = Math.max(4, Math.min(parentRect.top, window.innerHeight - subRect.height - 4)) + 'px';

    return sub;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {object} session
   * @param {HTMLElement} anchorEl
   */
  function openContextMenu(x, y, session, anchorEl) {
    closeContextMenu();
    hidePreview();

    const menu = document.createElement('div');
    menu.className = 'session-context-menu';
    menu.setAttribute('role', 'menu');

    const items = [
      { label: 'Show details', action: function () {
          pendingPreviewSessionId = session.sessionId;
          pendingPreviewAnchor = anchorEl;
          vscodeApi.postMessage({ type: 'getSessionPreview', sessionId: session.sessionId });
      }},
      { label: 'Copy title', action: function () {
          vscodeApi.postMessage({ type: 'copyToClipboard', text: session.title || '' });
      }},
      { label: 'Copy session ID', action: function () {
          vscodeApi.postMessage({ type: 'copyToClipboard', text: session.sessionId });
      }},
      { label: 'Copy transcript', submenu: [
          { label: 'To editor', action: function () {
              vscodeApi.postMessage({ type: 'copyTranscriptToEditor', sessionId: session.sessionId });
          }},
          { label: 'To clipboard', action: function () {
              vscodeApi.postMessage({ type: 'copyTranscriptToClipboard', sessionId: session.sessionId });
          }},
          { label: 'To file', action: function () {
              vscodeApi.postMessage({ type: 'copyTranscriptToFile', sessionId: session.sessionId });
          }},
      ]},
      { label: 'Upload to the corpus', action: function () {
          vscodeApi.postMessage({ type: 'uploadToCorpus', sessionId: session.sessionId });
      }},
    ];

    items.forEach(function (itemDef) {
      const btn = document.createElement('button');
      btn.className = 'session-context-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.type = 'button';
      btn.textContent = itemDef.label;
      if (itemDef.submenu) {
        btn.classList.add('session-context-menu-item--parent');
        let subEl = null;
        let openTimer = null;
        let closeTimer = null;
        const openSub = function () {
          clearTimeout(closeTimer);
          if (subEl) { return; }
          subEl = renderSubmenu(btn, itemDef.submenu);
        };
        const closeSub = function () {
          if (!subEl) { return; }
          subEl.remove();
          subEl = null;
        };
        btn.addEventListener('mouseenter', function () {
          clearTimeout(closeTimer);
          openTimer = setTimeout(openSub, 150);
        });
        btn.addEventListener('mouseleave', function (event) {
          clearTimeout(openTimer);
          // Give the pointer time to reach the submenu before we tear it down.
          closeTimer = setTimeout(function () {
            if (subEl && !subEl.contains(event.relatedTarget)) { closeSub(); }
          }, 200);
        });
        btn.addEventListener('click', openSub);
        btn.addEventListener('keydown', function (event) {
          if (event.key === 'ArrowRight' || event.key === 'Enter') {
            event.preventDefault();
            openSub();
            const first = subEl && subEl.querySelector('.session-context-menu-item');
            if (first) { first.focus(); }
          }
        });
      } else {
        btn.addEventListener('click', function () {
          itemDef.action();
          closeContextMenu();
        });
      }
      menu.appendChild(btn);
    });

    // Measure before placing so we can clamp against viewport edges.
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const finalX = Math.min(x, window.innerWidth  - rect.width  - 4);
    const finalY = Math.min(y, window.innerHeight - rect.height - 4);
    menu.style.left = Math.max(4, finalX) + 'px';
    menu.style.top  = Math.max(4, finalY) + 'px';

    contextMenuEl = menu;
    const firstItem = menu.querySelector('.session-context-menu-item');
    if (firstItem) { firstItem.focus(); }
  }

  // ── Sort menu ─────────────────────────────────────────────────────────────

  function closeSortMenu() {
    if (sortMenuEl) { sortMenuEl.remove(); sortMenuEl = null; }
    if (sortBtn) { sortBtn.setAttribute('aria-expanded', 'false'); }
  }

  /** The label of the active mode, for the toolbar button's tooltip. */
  function currentSortLabel() {
    for (let i = 0; i < sortModes.length; i++) {
      if (sortModes[i].id === sortMode) { return sortModes[i].label; }
    }
    return sortMode;
  }

  // The tooltip names the active order, so "how is this list sorted" is answerable without
  // opening the menu. Deliberately does not touch an open menu: sessions refresh every few
  // seconds, and rebuilding the menu under the pointer would move the item being clicked.
  function refreshSortButton() {
    if (!sortBtn) { return; }
    const label = 'Sort sessions — ' + currentSortLabel();
    sortBtn.title = label;
    // `title` is not reliably announced and never shows on keyboard focus, so the name is set as
    // well as the tooltip — and from the same string, so the two cannot drift.
    sortBtn.setAttribute('aria-label', label);
  }

  /**
   * The sort picker. Items come from the extension host (`sortModes`), so the panel can only
   * offer orders the sorter actually implements — there is no second list to keep in step.
   */
  function openSortMenu() {
    closeSortMenu();
    if (!sortBtn) { return; }

    const menu = document.createElement('div');
    menu.className = 'session-context-menu';
    menu.setAttribute('role', 'menu');

    const modes = sortModes.length ? sortModes : [{ id: 'recent', label: 'Recently updated' }];
    modes.forEach(function (mode) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'session-context-menu-item session-sort-item';
      btn.setAttribute('role', 'menuitemradio');
      const active = mode.id === sortMode;
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
      if (active) { btn.classList.add('session-sort-item--active'); }

      const check = document.createElement('span');
      check.className = 'session-sort-check';
      // A fixed-width column either way, so the labels line up whichever mode is active.
      check.textContent = active ? '✓' : '';
      btn.appendChild(check);
      btn.appendChild(document.createTextNode(mode.label));
      if (mode.description) { btn.title = mode.description; }

      btn.addEventListener('click', function () {
        closeSortMenu();
        if (mode.id === sortMode) { return; }
        // The host owns the ordering: it records the choice in settings — which is what makes it
        // survive a reload — and pushes the re-sorted rows straight back. Showing the new mode
        // here first only keeps the button's tooltip honest in the meantime.
        sortMode = mode.id;
        refreshSortButton();
        vscodeApi.postMessage({ type: 'setSessionSort', mode: mode.id });
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    sortMenuEl = menu;
    sortBtn.setAttribute('aria-expanded', 'true');
    // Arrow keys and Escape-restores-focus, shared with the ☰ menu rather than written twice.
    if (window.SessionSitterMenu && window.SessionSitterMenu.wireMenuKeys) {
      window.SessionSitterMenu.wireMenuKeys(menu, sortBtn, closeSortMenu);
    }

    // Anchor under the button (the menu is position: fixed).
    const rect = sortBtn.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width;
    menu.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4)) + 'px';
    menu.style.top = rect.bottom + 'px';

    const checked = menu.querySelector('.session-sort-item--active') ||
      menu.querySelector('.session-context-menu-item');
    if (checked) { checked.focus(); }
  }

  // ── Tab builder ───────────────────────────────────────────────────────────

  /** How each agent is named on a badge and in a status tooltip. One list, so they agree. */
  const SOURCE_LABELS = { claude: 'Claude', bob: 'Bob', codex: 'Codex', chat: 'Chat' };

  /** Agents that expose no liveness signal at all, so their rows can only ever be dormant. */
  const PROBELESS_SOURCES = ['codex', 'chat'];

  /**
   * The period of the `working` spinner, in milliseconds.
   *
   * Must match `animation: spin <duration>` on `.status-working` in styles.css. A test asserts the
   * two agree, because a mismatch is invisible in review and shows up only as a marker that jumps
   * instead of turning.
   */
  const SPIN_PERIOD_MS = 700;

  // The metadata line shared by buildTab and buildHistoryItem: the source badge
  // (Claude/Bob/Codex/Chat), the machine pill and the workspace pill, all on ONE wrapping line.
  // They used to be a child each of `.tab-text`, which is a flex column — so a row was four or
  // five lines tall and twenty sessions were a very long scroll in a narrow sidebar.
  // Returns the line, so the caller can put the timestamp on the end of it.
  function appendSessionMeta(textEl, session) {
    const metaEl = document.createElement('div');
    metaEl.className = 'tab-meta';
    const label = SOURCE_LABELS[session.source];
    if (label) {
      const sourceBadge = document.createElement('span');
      sourceBadge.className = 'tab-badge tab-badge--' + session.source;
      sourceBadge.textContent = label;
      metaEl.appendChild(sourceBadge);
    }

    // A session on another machine gets the machine's name, because "which box is this on" is
    // the first thing you need to know about it. Local sessions carry no such badge, so an
    // unbadged row still means "here".
    if (session.peer) {
      const peerBadge = document.createElement('span');
      peerBadge.className = 'tab-badge tab-badge--peer';
      // Show the host, not user@host: the username is noise once you know the machine.
      peerBadge.textContent = String(session.peer).split('@').pop().split('.')[0];
      peerBadge.title = 'on ' + session.peer;
      metaEl.appendChild(peerBadge);
    }

    const workspaceBadge = document.createElement('span');
    workspaceBadge.className = 'tab-badge';
    workspaceBadge.textContent = session.projectName || '(no workspace)';
    if (!session.projectName) {
      workspaceBadge.classList.add('tab-badge--empty');
    }
    // A workspace the user gave a colour to (sessionSitter.workspaceColors). The extension host
    // resolves the pair — it owns the setting — and sends nothing at all for an uncoloured
    // workspace, which is what leaves that pill on the theme's badge colour.
    if (session.workspaceColor && session.workspaceColor.background) {
      workspaceBadge.classList.add('tab-badge--colored');
      workspaceBadge.style.backgroundColor = session.workspaceColor.background;
      workspaceBadge.style.color = session.workspaceColor.foreground || '#ffffff';
    }
    metaEl.appendChild(workspaceBadge);

    textEl.appendChild(metaEl);
    return metaEl;
  }

  /**
   * @param {object} session
   * @returns {HTMLElement}
   */
  function buildTab(session) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.sessionId = session.sessionId;
    tab.setAttribute('role', 'tab');
    // Which row is the session you are in. The host sends the id; every other row is explicitly
    // false, because a `role="tab"` with no aria-selected reads as "not a tab in a tablist".
    tab.setAttribute('aria-selected', session.sessionId === currentSessionId ? 'true' : 'false');
    // Overwritten by applyRovingTabindex() once the whole list is built — see the note there.
    tab.setAttribute('tabindex', '-1');
    tab.setAttribute('title', (session.title || '(untitled)') + ' — ' + formatRelativeTime(session.updatedAt));

    const statusEl = buildStatusIndicator(session);

    const textEl = document.createElement('div');
    textEl.className = 'tab-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = session.title || '(untitled)';
    textEl.appendChild(titleEl);

    const metaEl = appendSessionMeta(textEl, session);

    const timeEl = document.createElement('span');
    timeEl.className = 'tab-time';
    timeEl.textContent = formatRelativeTime(session.updatedAt);
    metaEl.appendChild(timeEl);

    tab.appendChild(statusEl);
    tab.appendChild(textEl);

    if (session.source !== 'bob') {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.setAttribute('aria-label', 'Remove from tab bar');
      closeBtn.setAttribute('title', 'Remove from tab bar');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        vscodeApi.postMessage({ type: 'removeTab', sessionId: session.sessionId });
      });
      tab.appendChild(closeBtn);
    }

    tab.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'switchSession', sessionId: session.sessionId });
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (event.target && event.target.classList && event.target.classList.contains('tab-close')) { return; }
        event.preventDefault();
        vscodeApi.postMessage({ type: 'switchSession', sessionId: session.sessionId });
        return;
      }
      const rows = tabStrip ? Array.prototype.slice.call(tabStrip.querySelectorAll('.tab')) : [];
      const here = rows.indexOf(tab);
      let next = -1;
      if (event.key === 'ArrowDown') { next = here + 1; }
      else if (event.key === 'ArrowUp') { next = here - 1; }
      else if (event.key === 'Home') { next = 0; }
      else if (event.key === 'End') { next = rows.length - 1; }
      else { return; }
      // Deliberately does not wrap: the ends of the list are where History and the toolbar are,
      // and silently jumping to the other end loses your place.
      event.preventDefault();
      focusRow(rows, next);
    });

    tab.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, session, tab);
    });

    tab.addEventListener('mouseenter', function () {
      scheduleHoverPreview(session, tab);
    });
    tab.addEventListener('mouseleave', cancelHoverPreview);

    return tab;
  }

  // ── History item builder ──────────────────────────────────────────────────

  /**
   * @param {object} session
   * @returns {HTMLElement}
   */
  function buildHistoryItem(session) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('tabindex', '0');
    item.setAttribute('title', (session.title || '(untitled)') + ' — ' + formatRelativeTime(session.updatedAt));

    const textEl = document.createElement('div');
    textEl.className = 'tab-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = session.title || '(untitled)';
    textEl.appendChild(titleEl);

    const metaEl = appendSessionMeta(textEl, session);

    const timeEl = document.createElement('span');
    timeEl.className = 'history-time';
    timeEl.textContent = formatRelativeTime(session.updatedAt);
    metaEl.appendChild(timeEl);

    item.appendChild(textEl);

    const activate = () => {
      vscodeApi.postMessage({ type: 'addFromHistory', sessionId: session.sessionId });
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });

    item.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, session, item);
    });

    item.addEventListener('mouseenter', function () {
      scheduleHoverPreview(session, item);
    });
    item.addEventListener('mouseleave', cancelHoverPreview);

    return item;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function renderTabs() {
    if (!tabStrip) { return; }
    tabStrip.innerHTML = '';
    if (sessions.length === 0) {
      const placeholder = document.createElement('span');
      placeholder.className = 'tab-placeholder';
      placeholder.textContent = 'No active sessions — click + to start one';
      tabStrip.appendChild(placeholder);
      // Still say which machines are unreachable: "no sessions" and "could not ask" are very
      // different things, and this is exactly the case where confusing them misleads.
      appendPeerWarning();
      return;
    }
    sessions.forEach(session => tabStrip.appendChild(buildTab(session)));
    applyRovingTabindex();
    appendPeerWarning();
  }

  /**
   * One tab stop for the whole list, not one per row.
   *
   * A `role="tab"` list is reached once and then walked with the arrow keys (see the row's keydown
   * handler); giving 20 rows `tabindex="0"` each instead means 20 presses of Tab before you reach
   * History. The reachable row is the selected one, or the first when the host reports none.
   */
  function applyRovingTabindex() {
    const rows = tabStrip ? tabStrip.querySelectorAll('.tab') : [];
    let chosen = -1;
    rows.forEach(function (row, i) {
      if (chosen < 0 && row.getAttribute('aria-selected') === 'true') { chosen = i; }
    });
    if (rows.length && chosen < 0) { chosen = 0; }
    rows.forEach(function (row, i) {
      row.setAttribute('tabindex', i === chosen ? '0' : '-1');
    });
  }

  /** Move focus to another row, carrying the single tab stop with it. */
  function focusRow(rows, index) {
    if (index < 0 || index >= rows.length) { return; }
    rows.forEach(function (r) { r.setAttribute('tabindex', '-1'); });
    rows[index].setAttribute('tabindex', '0');
    rows[index].focus();
  }

  // Name the peers that could not be reached this pass.
  //
  // Reachability is one-way in practice: this machine may reach a server while the server cannot
  // reach back through NAT. Silently omitting an unreachable machine would look identical to that
  // machine having no sessions, so an unreachable peer is stated rather than hidden.
  function appendPeerWarning() {
    if (!tabStrip) { return; }
    const down = peerStatuses.filter(p => p && p.reachable === false);
    if (down.length === 0) { return; }
    const el = document.createElement('div');
    el.className = 'peer-warning';
    el.textContent = 'Not reachable: ' + down.map(p => String(p.peer).split('@').pop()).join(', ');
    el.title = down.map(p => String(p.peer) + ' — ' + (p.error || 'unreachable')).join('\n');
    tabStrip.appendChild(el);
  }

  function renderHistory() {
    if (!historyPanel) { return; }
    historyPanel.innerHTML = '';
    if (historySessions.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tab-placeholder';
      empty.textContent = 'No past sessions found';
      historyPanel.appendChild(empty);
      return;
    }
    historySessions.forEach(session => historyPanel.appendChild(buildHistoryItem(session)));
  }

  // ── Supervision activity feed ──────────────────────────────────────────────

  const ACTIVITY_ICON = { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴' };

  /** Friendly label for a lifecycle state. */
  function activityStateLabel(item) {
    switch (item.state) {
      case 'green_completed':
        return item.summary && item.summary.indexOf('asking') === 0 ? 'asked you' : 'auto-approved';
      case 'yellow_delivered': return 'auto-corrected';
      case 'orange_awaiting_user': return (item.awaitLight === 'red' ? 'BLOCK?' : 'decision needed') + ' — awaiting you';
      case 'orange_resolved_by_user': return 'resolved by you';
      case 'orange_transitioned_to_yellow': return 'denied → alternatives';
      case 'red_blocked': return 'blocked';
      case 'rule_applied': return ruleStateLabel(item);
      case 'failed': return 'failed';
      default: return item.state || '';
    }
  }

  /**
   * What a deterministic rule did, for the state badge. Derived from the traffic light the
   * recorder assigned: green = approved, red = rejected, yellow = a canned reply was sent.
   */
  function ruleStateLabel(item) {
    if (item.light === 'red') { return 'rule auto-rejected'; }
    if (item.light === 'yellow') { return 'rule auto-replied'; }
    return 'rule auto-approved';
  }

  /** Small labeled line: "label value" with the label muted. */
  function activityLine(cls, label, value) {
    const el = document.createElement('div');
    el.className = 'activity-line ' + cls;
    const l = document.createElement('span');
    l.className = 'activity-line-label';
    l.textContent = label + ' ';
    el.appendChild(l);
    el.appendChild(document.createTextNode(value));
    return el;
  }

  /**
   * Which session a decision belongs to, and the machine it ran on. Always rendered: several
   * sessions — and, since peers landed, several machines — report into this one feed, so a card
   * that names neither cannot be acted on. The session id stays in the tooltip.
   * @param {object} item
   * @returns {HTMLElement}
   */
  function buildSessionRef(item) {
    const el = document.createElement('div');
    el.className = 'activity-line activity-session';
    const name = document.createElement('span');
    name.className = 'activity-session-name';
    name.textContent = '🗂 ' + (item.sessionName || item.sessionId || 'unknown session');
    el.appendChild(name);
    if (item.host) {
      const host = document.createElement('span');
      host.className = 'activity-session-host';
      host.textContent = '🖥 ' + item.host;
      el.appendChild(host);
    }
    el.title = 'session ' + (item.sessionId || '(unknown)')
      + (item.host ? ' on ' + item.host : '');
    return el;
  }

  /**
   * What each status marker means, in words, for its tooltip.
   *
   * Six shapes are only learnable if hovering explains them, so every state gets a sentence —
   * including the quiet ones, which previously had no tooltip at all and so left you guessing
   * whether a grey row was finished or simply unknown. `dormant` says which of the two it is,
   * because for Codex and VS Code Chat there is genuinely no liveness signal to read.
   *
   * @param {object} session
   * @returns {string}
   */
  function statusTooltip(session) {
    const agent = SOURCE_LABELS[session.source] || 'The agent';
    switch (session.status) {
      case 'approval': return agent + ' is waiting for your approval to run a tool.';
      case 'question': return agent + ' asked you a question and is waiting for an answer.';
      case 'finished': return agent + ' finished. You have not opened this since.';
      case 'working':  return agent + ' is working — running a tool or writing a reply.';
      case 'seen':     return 'Finished, and you have read it.';
      default:
        return PROBELESS_SOURCES.indexOf(session.source) !== -1
          ? 'No liveness signal — ' + agent + ' does not report whether it is working.'
          : 'Nothing is happening in this session.';
    }
  }

  /**
   * The status marker: one element, distinguished by SHAPE first and colour second.
   *
   * Shape carries the meaning because an 8-10px dot has no room for detail, and because colour
   * alone excludes anyone who cannot separate the hues — the CSS gives each state its own
   * silhouette so the row still reads in a high-contrast theme. Motion is reserved for `working`:
   * a marker that moves says "leave this alone", which is precisely the wrong thing to say about a
   * session that is blocked waiting for you.
   *
   * @param {object} session
   * @returns {HTMLElement}
   */
  function buildStatusIndicator(session) {
    const status = session.status || 'dormant';
    const el = document.createElement('span');
    el.className = 'status-indicator status-' + status;
    if (status === 'working') {
      // Anchor the spin's phase to the wall clock.
      //
      // renderTabs() clears the strip and rebuilds every row on every push, and a brand-new element
      // starts its animation at 0deg. Pushes are driven by `sessionsFingerprint` moving, which for a
      // streaming session means every 250ms watcher debounce — Claude writes the transcript far
      // faster than that. So the one state that animates is also the one rebuilt several times a
      // second, and the ring kept snapping back to 0 before it had turned a quarter. It read as a
      // ring twitching in place rather than one turning.
      //
      // A negative delay starts the animation mid-cycle instead of postponing it, so each new
      // element picks up the phase the one it replaced was at.
      el.style.animationDelay = '-' + ((Date.now() % SPIN_PERIOD_MS) / 1000) + 's';
    }
    const tip = statusTooltip(session);
    el.setAttribute('title', tip);
    // The shape is the whole content, so a screen reader gets nothing without this.
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', tip);
    return el;
  }

  /**
   * @param {object} item
   * @returns {HTMLElement}
   */
  function buildActivityItem(item) {
    const light = item.light || (item.awaitLight || '');
    const awaiting = item.state === 'orange_awaiting_user';
    const card = document.createElement('div');
    card.className = 'activity-item activity-' + (light || 'none') + (awaiting ? ' activity-awaiting' : '');

    // Header: icon + LIGHT + state badge
    const head = document.createElement('div');
    head.className = 'activity-head';
    const dot = document.createElement('span');
    dot.className = 'activity-dot';
    dot.textContent = ACTIVITY_ICON[light] || '⚪';
    head.appendChild(dot);
    const lightLbl = document.createElement('span');
    lightLbl.className = 'activity-light';
    lightLbl.textContent = (light || 'info').toUpperCase();
    head.appendChild(lightLbl);
    const badge = document.createElement('span');
    badge.className = 'activity-state';
    badge.textContent = activityStateLabel(item);
    head.appendChild(badge);
    // Who decided: a deterministic rule, or the supervisor (model + knowledge). Both are real
    // interventions, so both are shown — the badge is what tells them apart at a glance.
    const by = document.createElement('span');
    const isRule = item.decidedBy === 'rule';
    by.className = 'activity-by ' + (isRule ? 'activity-by-rule' : 'activity-by-ai');
    by.textContent = isRule ? '⚙ rule' : '🧠 AI';
    by.title = isRule
      ? 'Decided by a deterministic sessionSitter.autoRespond rule — no model was consulted'
      : 'Decided by the supervisor (classifier + your knowledge tiers)';
    head.appendChild(by);
    const time = document.createElement('span');
    time.className = 'activity-timeago';
    time.textContent = formatRelativeTime(item.at);
    head.appendChild(time);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'activity-body';

    body.appendChild(buildSessionRef(item));
    if (item.summary) {
      const summary = document.createElement('div');
      summary.className = 'activity-summary';
      summary.textContent = item.summary;
      body.appendChild(summary);
    }
    if (item.ruleLabel) {
      body.appendChild(activityLine('activity-rule', '⚙ rule:', item.ruleLabel));
    }
    if (item.userIntent) { body.appendChild(activityLine('activity-req', '🧑', item.userIntent)); }
    if (item.agentIntent) { body.appendChild(activityLine('activity-act', '🤖', item.agentIntent)); }
    if (item.humanNotification) {
      const note = document.createElement('div');
      note.className = 'activity-note';
      note.textContent = item.humanNotification;
      body.appendChild(note);
    }
    if (Array.isArray(item.options) && item.options.length) {
      const chips = document.createElement('div');
      chips.className = 'activity-chips';
      item.options.forEach(function (o) {
        const chip = document.createElement('span');
        chip.className = 'activity-chip';
        chip.textContent = o;
        chips.appendChild(chip);
      });
      body.appendChild(chips);
    }
    if (item.userResponse) {
      body.appendChild(activityLine('activity-you', '💬 you:', item.userResponse));
    }
    if (awaiting) {
      const wait = document.createElement('div');
      wait.className = 'activity-awaiting-badge';
      // Name where the card actually went. The default channel is `stub`, which writes it to a
      // file under the state dir — telling you to check Telegram then points at nothing.
      if (messagingChannel === 'telegram') {
        wait.textContent = '⏳ awaiting your decision on Telegram';
      } else {
        wait.textContent = '⏳ awaiting your decision — see notifications/';
        wait.title = 'Decision card written to '
          + (notificationsDir || '<stateDir>/notifications')
          + (item.requestId ? '/' + item.requestId + '.txt' : '');
      }
      body.appendChild(wait);
    }
    if (item.state === 'failed') {
      card.classList.add('activity-failed');
      body.appendChild(buildFailureDetail(item));
    }

    card.appendChild(body);
    return card;
  }

  /**
   * Collapsible "why did this fail?" region for a failed supervision: the recorded error text
   * plus actions to open the full record JSON or copy its path — so a failure is debuggable
   * from the panel instead of a dead end.
   * @param {object} item
   * @returns {HTMLElement}
   */
  function buildFailureDetail(item) {
    const wrap = document.createElement('div');
    wrap.className = 'activity-failure';

    const detail = document.createElement('div');
    detail.className = 'activity-fail-detail';
    detail.hidden = true;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'activity-fail-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '▶ Why it failed';
    toggle.addEventListener('click', function () {
      const open = detail.hidden;
      detail.hidden = !open;
      toggle.textContent = (open ? '▼' : '▶') + ' Why it failed';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    wrap.appendChild(toggle);

    const err = document.createElement('pre');
    err.className = 'activity-error';
    err.textContent = item.error || 'No error message was recorded for this failure.';
    detail.appendChild(err);

    const actions = document.createElement('div');
    actions.className = 'activity-fail-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'activity-fail-btn';
    openBtn.textContent = 'Open record';
    openBtn.addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'openSupervisionRecord', requestId: item.requestId });
    });
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'activity-fail-btn';
    copyBtn.textContent = 'Copy path';
    copyBtn.addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'copySupervisionRecordPath', requestId: item.requestId });
    });
    actions.appendChild(openBtn);
    actions.appendChild(copyBtn);
    detail.appendChild(actions);

    wrap.appendChild(detail);
    return wrap;
  }

  /** @type {string} — the feed as last rendered, so an unchanged push is not re-rendered */
  let renderedActivityKey = '';

  function renderActivity() {
    if (!activityPanel) { return; }
    // The host re-pushes the whole feed on every poll. Rebuilding it unchanged would re-announce
    // the lot through the panel's aria-live region and collapse any open "why it failed" detail.
    const key = JSON.stringify([messagingChannel, activityItems]);
    if (key === renderedActivityKey && activityPanel.childElementCount) { return; }
    renderedActivityKey = key;
    activityPanel.innerHTML = '';
    if (activityItems.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tab-placeholder';
      empty.textContent = 'No supervision activity yet';
      activityPanel.appendChild(empty);
      return;
    }
    activityItems.forEach(function (item) { activityPanel.appendChild(buildActivityItem(item)); });
  }

  /**
   * Tell the host a section was just opened or collapsed, so it reopens that way.
   *
   * Called from the click handlers only, never from the state restored at load — writing the
   * remembered value back while applying it is how a restore turns into a reset.
   */
  function rememberSection(section, open) {
    vscodeApi.postMessage({ type: 'setPanelSection', section: section, open: open });
  }

  function setActivityOpen(open) {
    activityOpen = open;
    if (!activityToggle || !activityPanel) { return; }
    activityToggle.textContent = open ? 'Supervision activity ▼' : 'Supervision activity ▶';
    activityToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    activityPanel.hidden = !open;
    if (open) { vscodeApi.postMessage({ type: 'loadActivity' }); }
  }

  function setHistoryOpen(open) {
    historyOpen = open;
    if (!historyToggle || !historyPanel) { return; }
    historyToggle.textContent = open ? 'History ▼' : 'History ▶';
    historyToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    historyPanel.hidden = !open;
    if (open) {
      vscodeApi.postMessage({ type: 'loadHistory' });
    } else {
      vscodeApi.postMessage({ type: 'closeHistory' });
    }
  }

  // ── Message handling ─────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') { return; }

    switch (message.type) {
      case 'updateSessions':
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        currentSessionId = typeof message.currentSessionId === 'string' ? message.currentSessionId : null;
        peerStatuses = Array.isArray(message.peers) ? message.peers : [];
        // The host sorted the rows already; these only drive the menu's check mark and tooltip.
        if (Array.isArray(message.sortModes)) { sortModes = message.sortModes; }
        if (typeof message.sortMode === 'string') { sortMode = message.sortMode; }
        refreshSortButton();
        renderTabs();
        break;
      case 'updateHistory':
        historySessions = Array.isArray(message.sessions) ? message.sessions : [];
        renderHistory();
        break;
      case 'updateActivity':
        activityItems = Array.isArray(message.items) ? message.items : [];
        if (typeof message.channel === 'string') { messagingChannel = message.channel; }
        if (typeof message.notificationsDir === 'string') { notificationsDir = message.notificationsDir; }
        renderActivity();
        break;
      case 'sessionPreview': {
        if (pendingPreviewSessionId !== message.sessionId) { break; }
        const anchorEl = pendingPreviewAnchor;
        pendingPreviewSessionId = null;
        pendingPreviewAnchor = null;
        if (anchorEl) {
          const previewSession = sessions.find(function (s) { return s.sessionId === message.sessionId; })
            || historySessions.find(function (s) { return s.sessionId === message.sessionId; });
          const assistantName =
            previewSession && previewSession.source === 'bob' ? 'Bob' :
            previewSession && previewSession.source === 'codex' ? 'Codex' :
            previewSession && previewSession.source === 'chat' ? 'Chat' :
            'Claude';
          showPreview(message.projectPath || '', message.exchanges || [], anchorEl, assistantName);
        }
        break;
      }
    }
  });

  // ── Initialization ───────────────────────────────────────────────────────

  function init() {
    tabStrip      = document.getElementById('tab-strip');
    historyToggle = document.getElementById('history-toggle');
    historyPanel  = document.getElementById('history-panel');
    previewEl      = document.getElementById('session-preview');
    activityToggle = document.getElementById('activity-toggle');
    activityPanel  = document.getElementById('activity-panel');
    sortBtn        = document.getElementById('sort-btn');

    if (sortBtn) {
      refreshSortButton();
      sortBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (sortMenuEl) { closeSortMenu(); } else { openSortMenu(); }
      });
    }

    const newBtn = document.getElementById('new-session-btn');
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'newSession' });
      });
    }

    const newBobBtn = document.getElementById('new-bob-session-btn');
    if (newBobBtn) {
      newBobBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'newBobSession' });
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (contextMenuEl) { closeContextMenu(); }
        if (sortMenuEl) { closeSortMenu(); }
        if (previewEl && !previewEl.hidden) { hidePreview(); }
      }
    });

    // Dismiss context menu / sort menu / preview when clicking outside of them.
    document.addEventListener('mousedown', (event) => {
      if (contextMenuEl && !contextMenuEl.contains(event.target)) {
        closeContextMenu();
      }
      if (sortMenuEl && !sortMenuEl.contains(event.target) && event.target !== sortBtn) {
        closeSortMenu();
      }
      if (previewEl && !previewEl.hidden && !previewEl.contains(event.target)) {
        hidePreview();
      }
    });

    if (historyToggle) {
      historyToggle.addEventListener('click', () => {
        const open = !historyOpen;
        rememberSection('history', open);
        setHistoryOpen(open);
      });
    }

    if (activityToggle) {
      activityToggle.addEventListener('click', () => {
        const open = !activityOpen;
        rememberSection('activity', open);
        setActivityOpen(open);
      });
    }

    // Adopt what the host rendered. Run through the same setters a click uses, so an open section
    // also asks for its rows — a restored-open History that never loaded would just look empty.
    if (historyToggle) { setHistoryOpen(historyToggle.getAttribute('aria-expanded') === 'true'); }
    if (activityToggle) { setActivityOpen(activityToggle.getAttribute('aria-expanded') === 'true'); }
    renderActivity();

    // The hamburger menu (About + Settings…) lives in its own small module. It cannot call
    // acquireVsCodeApi() itself — only one call per webview is allowed — so it is handed a
    // postMessage function.
    if (window.SessionSitterMenu) {
      window.SessionSitterMenu.init({ postMessage: (msg) => vscodeApi.postMessage(msg) });
    }

    renderTabs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); vscodeApi.postMessage({ type: 'ready' }); });
  } else {
    init();
    vscodeApi.postMessage({ type: 'ready' });
  }
}());
