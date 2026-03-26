(function () {
  const token = new URLSearchParams(window.location.search).get('token')

  const refs = {
    workspaceName: document.getElementById('workspaceName'),
    statusCopy: document.getElementById('statusCopy'),
    repoCount: document.getElementById('repoCount'),
    repoList: document.getElementById('repoList'),
    repoDetail: document.getElementById('repoDetail'),
    terminalTitle: document.getElementById('terminalTitle'),
    terminalMeta: document.getElementById('terminalMeta'),
    terminal: document.getElementById('terminal'),
  }

  if (!token) {
    refs.statusCopy.textContent = 'Missing local UI token. Re-run `hexgrid ui`.'
    return
  }

  const state = {
    snapshot: null,
    selectedRepoId: null,
    terminal: null,
    fitAddon: null,
    terminalStream: null,
    controlStream: null,
    terminalSessionKey: null,
    refreshTimer: null,
    pendingInput: '',
    pendingInputTimer: null,
  }

  function escapeHtml(input) {
    return String(input ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function apiUrl(path) {
    const url = new URL(path, window.location.origin)
    url.searchParams.set('token', token)
    return url.toString()
  }

  async function request(path, options = {}) {
    const init = {
      method: options.method ?? 'GET',
      headers: { ...(options.headers ?? {}) },
    }

    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }

    const response = await fetch(apiUrl(path), init)
    let data = {}
    try {
      data = await response.json()
    } catch {
      data = {}
    }

    if (!response.ok) {
      throw new Error(data.error ?? `${init.method} ${path} failed (${response.status})`)
    }

    return data
  }

  function setStatus(message) {
    refs.statusCopy.textContent = message
  }

  function formatAge(timestamp) {
    if (!timestamp) return 'n/a'
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp))
    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
  }

  function getRepo(repoId) {
    return state.snapshot?.repos?.find(repo => repo.repo_id === repoId) ?? null
  }

  function getSelectedRepo() {
    return getRepo(state.selectedRepoId)
  }

  function getManagedSession(repo) {
    const session = repo?.managed_session ?? null
    if (!session) return null
    if (!['starting', 'running', 'stopping'].includes(session.status)) return null
    return session
  }

  function getSessionKey(repo) {
    const session = getManagedSession(repo)
    return session ? `${repo.repo_id}:${session.session_id}:${session.status}` : null
  }

  function initTerminal() {
    if (state.terminal) return

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"SF Mono", Monaco, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#08111b',
        foreground: '#dbe7f5',
        cursor: '#f4d35e',
        selectionBackground: 'rgba(121, 192, 255, 0.24)',
        black: '#08111b',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#f2cc60',
        blue: '#79c0ff',
        magenta: '#d2a8ff',
        cyan: '#a5f3fc',
        white: '#dbe7f5',
        brightBlack: '#4d5a6a',
        brightRed: '#ffa198',
        brightGreen: '#91e7b1',
        brightYellow: '#f6d88f',
        brightBlue: '#a6d4ff',
        brightMagenta: '#e1bbff',
        brightCyan: '#c0fbff',
        brightWhite: '#ffffff',
      },
    })
    const fitAddon = new FitAddon.FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(refs.terminal)
    fitAddon.fit()
    terminal.onData((data) => enqueueInput(data))
    window.addEventListener('resize', handleTerminalResize)

    state.terminal = terminal
    state.fitAddon = fitAddon
  }

  function showTerminalMessage(lines) {
    initTerminal()
    state.terminal.reset()
    for (const line of lines) {
      state.terminal.writeln(line)
    }
  }

  async function flushPendingInput() {
    const repo = getSelectedRepo()
    const session = getManagedSession(repo)
    const data = state.pendingInput

    state.pendingInput = ''
    state.pendingInputTimer = null

    if (!data || !session || session.status !== 'running') return

    try {
      await request(`/api/repos/${encodeURIComponent(repo.repo_id)}/terminal/input`, {
        method: 'POST',
        body: { data },
      })
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  function enqueueInput(data) {
    const repo = getSelectedRepo()
    const session = getManagedSession(repo)
    if (!session || session.status !== 'running') return

    state.pendingInput += data
    if (state.pendingInputTimer) return

    state.pendingInputTimer = window.setTimeout(() => {
      flushPendingInput().catch(() => {})
    }, 16)
  }

  function handleTerminalResize() {
    if (!state.terminal || !state.fitAddon) return
    state.fitAddon.fit()

    const repo = getSelectedRepo()
    const session = getManagedSession(repo)
    if (!session || session.status !== 'running') return

    request(`/api/repos/${encodeURIComponent(repo.repo_id)}/terminal/resize`, {
      method: 'POST',
      body: {
        cols: state.terminal.cols,
        rows: state.terminal.rows,
      },
    }).catch(() => {})
  }

  function disconnectTerminalStream() {
    if (state.terminalStream) {
      state.terminalStream.close()
      state.terminalStream = null
    }
  }

  function syncTerminal() {
    initTerminal()

    const repo = getSelectedRepo()
    if (!repo) {
      disconnectTerminalStream()
      state.terminalSessionKey = null
      refs.terminalTitle.textContent = 'Terminal'
      refs.terminalMeta.textContent = 'idle'
      showTerminalMessage(['No repo selected.'])
      return
    }

    refs.terminalTitle.textContent = `${repo.repo_id} terminal`

    const session = getManagedSession(repo)
    const nextKey = getSessionKey(repo)

    if (!session) {
      disconnectTerminalStream()
      state.terminalSessionKey = null
      refs.terminalMeta.textContent = 'not running'
      showTerminalMessage([
        `No local hex is running for ${repo.repo_id}.`,
        '',
        'Start Claude or Codex from this UI to open a local interactive terminal.',
      ])
      return
    }

    refs.terminalMeta.textContent = `${session.runtime} · ${session.status}`

    if (state.terminalSessionKey === nextKey) {
      handleTerminalResize()
      return
    }

    disconnectTerminalStream()
    state.terminalSessionKey = nextKey
    state.terminal.reset()

    const stream = new EventSource(apiUrl(`/api/repos/${encodeURIComponent(repo.repo_id)}/terminal/stream`))
    stream.addEventListener('reset', () => {
      state.terminal.reset()
    })
    stream.addEventListener('output', (event) => {
      const payload = JSON.parse(event.data)
      if (payload.chunk) state.terminal.write(payload.chunk)
    })
    stream.addEventListener('status', (event) => {
      const payload = JSON.parse(event.data)
      if (!payload.session) {
        refs.terminalMeta.textContent = 'waiting'
      }
    })
    stream.onerror = () => {
      refs.terminalMeta.textContent = 'reconnecting'
    }

    state.terminalStream = stream
    handleTerminalResize()
  }

  function renderRepoList() {
    const repos = state.snapshot?.repos ?? []
    refs.repoCount.textContent = `${repos.length} hexes`

    refs.repoList.innerHTML = repos.map((repo) => {
      const selected = repo.repo_id === state.selectedRepoId ? 'is-selected' : ''
      const local = getManagedSession(repo)
      const runtimeLabel = local ? `${local.runtime} ${local.status}` : 'local idle'

      return `
        <div class="repo-card ${selected}" data-select-repo="${escapeHtml(repo.repo_id)}">
          <div class="repo-card-header">
            <div class="repo-card-title">${escapeHtml(repo.repo_id)}</div>
            <div class="repo-card-status">${escapeHtml(repo.status)}</div>
          </div>
          <div class="repo-card-copy">${escapeHtml(repo.description ?? 'No description set for this hex yet.')}</div>
          <div class="repo-card-meta">
            <span class="repo-chip">${escapeHtml(runtimeLabel)}</span>
            <span class="repo-chip">${repo.counts?.pending_messages ?? 0} inbox</span>
            <span class="repo-chip">${repo.counts?.candidate_notes ?? 0} notes</span>
          </div>
          <div class="repo-card-actions">
            <button type="button" class="is-accent" data-start-runtime="codex" data-repo-id="${escapeHtml(repo.repo_id)}">Run Codex</button>
            <button type="button" data-start-runtime="claude" data-repo-id="${escapeHtml(repo.repo_id)}">Run Claude</button>
            <button type="button" class="is-danger" data-stop-repo="${escapeHtml(repo.repo_id)}">Stop</button>
          </div>
        </div>
      `
    }).join('')

    refs.repoList.querySelectorAll('[data-select-repo]').forEach((element) => {
      element.addEventListener('click', (event) => {
        if (event.target.closest('[data-start-runtime], [data-stop-repo]')) return
        state.selectedRepoId = element.dataset.selectRepo
        render()
        syncTerminal()
      })
    })

    refs.repoList.querySelectorAll('[data-start-runtime]').forEach((element) => {
      element.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        startRepo(element.dataset.repoId, element.dataset.startRuntime)
      })
    })

    refs.repoList.querySelectorAll('[data-stop-repo]').forEach((element) => {
      element.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        stopRepo(element.dataset.stopRepo)
      })
    })
  }

  function renderDetail() {
    const repo = getSelectedRepo()
    if (!repo) {
      refs.repoDetail.innerHTML = '<div class="empty-state">No hex selected.</div>'
      return
    }

    const local = getManagedSession(repo)
    const remoteSessionCount = repo.active_sessions?.length ?? 0
    const attention = repo.attention ?? []

    refs.repoDetail.innerHTML = `
      <div class="repo-detail-header">
        <div>
          <h2>${escapeHtml(repo.repo_id)}</h2>
          <div class="repo-detail-copy">${escapeHtml(repo.description ?? 'No repo description yet.')}</div>
        </div>
        <div class="detail-actions">
          <button type="button" class="is-accent" data-detail-start="codex">Run Codex</button>
          <button type="button" data-detail-start="claude">Run Claude</button>
          <button type="button" class="is-danger" data-detail-stop>Stop</button>
        </div>
      </div>

      <div class="repo-summary-grid">
        <span class="detail-note">status: ${escapeHtml(repo.status)}</span>
        <span class="detail-note">default: ${escapeHtml(repo.default_runtime ?? 'unset')}</span>
        <span class="detail-note">listen: ${escapeHtml(repo.listen ?? 'manual')}</span>
        <span class="detail-note">shared sessions: ${remoteSessionCount}</span>
        <span class="detail-note">pending inbox: ${repo.counts?.pending_messages ?? 0}</span>
      </div>

      <div class="detail-section">
        <div class="detail-label">Local Hex</div>
        <div class="repo-detail-copy">
          ${escapeHtml(local ? `${local.runtime} · ${local.status} · last output ${formatAge(local.last_output_at)}` : 'No local interactive hex is running.')}
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-label">Workspace Path</div>
        <div class="repo-detail-copy">${escapeHtml(repo.path ?? 'No local path bound.')}</div>
      </div>

      <div class="detail-section">
        <div class="detail-label">Attention</div>
        <div>
          ${attention.length > 0
            ? attention.map((item) => `<span class="detail-note">${escapeHtml(item)}</span>`).join('')
            : '<span class="detail-note">No local attention items.</span>'}
        </div>
      </div>
    `

    refs.repoDetail.querySelectorAll('[data-detail-start]').forEach((element) => {
      element.addEventListener('click', () => startRepo(repo.repo_id, element.dataset.detailStart))
    })

    const stopButton = refs.repoDetail.querySelector('[data-detail-stop]')
    if (stopButton) {
      stopButton.addEventListener('click', () => stopRepo(repo.repo_id))
    }
  }

  function render() {
    const repos = state.snapshot?.repos ?? []
    refs.workspaceName.textContent = state.snapshot?.workspace_name ?? 'workspace'

    if (!repos.some(repo => repo.repo_id === state.selectedRepoId)) {
      state.selectedRepoId = repos[0]?.repo_id ?? null
    }

    renderRepoList()
    renderDetail()
  }

  async function loadSnapshot() {
    const snapshot = await request('/api/snapshot')
    state.snapshot = snapshot
    render()
    syncTerminal()

    const authStatus = snapshot.auth?.status ?? 'unknown'
    const attention = snapshot.counts?.attention ?? 0
    setStatus(`Personal grid ${snapshot.workspace_name} · auth ${authStatus} · attention ${attention}`)
  }

  async function startRepo(repoId, runtime) {
    setStatus(`Starting ${repoId} with ${runtime}…`)
    if (repoId === state.selectedRepoId) {
      showTerminalMessage([`Starting ${repoId} with ${runtime}…`])
    }

    try {
      await request(`/api/repos/${encodeURIComponent(repoId)}/start`, {
        method: 'POST',
        body: { runtime },
      })
      await loadSnapshot()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  async function stopRepo(repoId) {
    setStatus(`Stopping ${repoId}…`)
    try {
      await request(`/api/repos/${encodeURIComponent(repoId)}/stop`, {
        method: 'POST',
      })
      await loadSnapshot()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  function connectControlStream() {
    const stream = new EventSource(apiUrl('/api/events'))
    stream.addEventListener('state', () => {
      window.clearTimeout(state.refreshTimer)
      state.refreshTimer = window.setTimeout(() => {
        loadSnapshot().catch((err) => {
          setStatus(err instanceof Error ? err.message : String(err))
        })
      }, 100)
    })
    stream.onerror = () => {
      setStatus('Local UI event stream disconnected. Waiting to reconnect…')
    }
    state.controlStream = stream
  }

  window.addEventListener('beforeunload', () => {
    disconnectTerminalStream()
    if (state.controlStream) state.controlStream.close()
  })

  connectControlStream()
  window.setInterval(() => {
    loadSnapshot().catch(() => {})
  }, 10_000)

  loadSnapshot().catch((err) => {
    setStatus(err instanceof Error ? err.message : String(err))
  })
})()
