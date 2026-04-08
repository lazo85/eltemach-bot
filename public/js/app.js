/* ═══════════════════════════════════════════════════════
   ElTemAIch Bot — Frontend
   ═══════════════════════════════════════════════════════ */

const API = '/api/bot';

let chatHistory = [];
let isSending = false;
let kbReady = false;
let currentUser = null;

// ─── Auth helpers ─────────────────────────────────────
function getToken() { return localStorage.getItem('temach_token'); }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
}

// ─── Init ─────────────────────────────────────────────
async function init() {
  const token = getToken();
  if (!token) {
    window.location.href = '/login';
    return;
  }

  await Promise.all([loadUser(), loadStatus()]);
}

async function loadUser() {
  try {
    const res = await fetch('/api/auth/me', { headers: authHeaders() });
    if (!res.ok) { localStorage.clear(); window.location.href = '/login'; return; }
    currentUser = await res.json();

    const profileLink = document.getElementById('profile-link');
    const tokenBadge  = document.getElementById('token-badge');
    const tokenCount  = document.getElementById('token-count');

    profileLink.textContent = currentUser.username;
    profileLink.style.display = 'inline-flex';
    tokenBadge.style.display  = 'inline-flex';
    tokenCount.textContent    = currentUser.is_admin ? '∞' : currentUser.tokens;

    if (!currentUser.is_admin && currentUser.tokens <= 0) {
      document.getElementById('no-tokens-msg').style.display = 'block';
      document.getElementById('send-btn').disabled = true;
    }

    // Admin: ocultar costo de token
    if (currentUser.is_admin) {
      const costEl = document.getElementById('send-token-cost');
      if (costEl) costEl.style.display = 'none';
    }

    if (currentUser.is_admin) {
      const nav = document.querySelector('.header-nav');
      const adminLink = document.createElement('a');
      adminLink.href = '/admin'; adminLink.className = 'nav-link';
      adminLink.textContent = 'Panel';
      nav.insertBefore(adminLink, profileLink);
    }
  } catch (err) {
    console.error('loadUser error:', err);
  }
}

async function loadStatus() {
  try {
    const res = await fetch(`${API}/status`, { headers: authHeaders() });
    const data = await res.json();
    const pill = document.getElementById('status-pill');
    const statusText = document.getElementById('status-text');

    if (data.ready) {
      kbReady = true;
      pill.classList.add('ready');
      statusText.textContent = 'En línea';
    } else {
      pill.classList.add('error');
      statusText.textContent = 'Sin indexar';
    }
  } catch (err) {
    console.error('Status error:', err);
  }
}

function updateTokenCount(tokensLeft) {
  if (tokensLeft === null || tokensLeft === undefined) return;
  document.getElementById('token-count').textContent = tokensLeft;
  if (tokensLeft <= 0) {
    document.getElementById('no-tokens-msg').style.display = 'block';
    document.getElementById('send-btn').disabled = true;
  }
}

// ─── Chat ─────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || isSending) return;

  if (currentUser && !currentUser.is_admin && currentUser.tokens <= 0) {
    document.getElementById('no-tokens-msg').style.display = 'block';
    return;
  }

  input.value = '';
  autoResize(input);
  isSending = true;
  setInputDisabled(true);

  chatHistory.push({ role: 'user', content: text });
  appendMessage('user', text);
  showTyping(true);
  scrollToBottom();

  try {
    const res = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ messages: chatHistory })
    });

    const data = await res.json();
    showTyping(false);

    if (!res.ok) {
      if (res.status === 401) { localStorage.clear(); window.location.href = '/login'; return; }
      if (data.noTokens) {
        document.getElementById('no-tokens-msg').style.display = 'block';
        document.getElementById('send-btn').disabled = true;
        chatHistory.pop();
      } else {
        appendMessage('bot', data.error || 'Error desconocido', true);
      }
    } else {
      chatHistory.push({ role: 'assistant', content: data.reply });
      appendMessage('bot', data.reply);
      if (data.sources?.length > 0) showSources(data.sources);
      if (data.tokensLeft !== null) updateTokenCount(data.tokensLeft);
    }
  } catch (err) {
    showTyping(false);
    appendMessage('bot', 'Error de conexión. Intenta de nuevo.', true);
    console.error('Chat error:', err);
  }

  isSending = false;
  setInputDisabled(false);
  if (currentUser?.is_admin || (currentUser?.tokens > 0)) {
    document.getElementById('send-btn').disabled = false;
  }
  scrollToBottom();
  document.getElementById('chat-input').focus();
}

function sendSuggestion(btn) {
  const text = btn.textContent.trim();
  document.getElementById('chat-input').value = text;
  sendMessage();
}

// ─── DOM helpers ──────────────────────────────────────
function appendMessage(role, text, isError = false) {
  const messages = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  const avatar = document.createElement('div');
  avatar.className = `msg-avatar ${role === 'bot' ? 'bot-avatar' : 'user-avatar'}`;

  if (role === 'bot') {
    avatar.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="2" width="3" height="7" rx="1.5" fill="white"/>
      <rect x="7" y="1" width="3" height="8" rx="1.5" fill="white"/>
      <rect x="11" y="1.5" width="3" height="7.5" rx="1.5" fill="white"/>
      <rect x="15" y="3" width="3" height="6" rx="1.5" fill="white"/>
      <rect x="2" y="7.5" width="17" height="7" rx="2" fill="white"/>
      <rect x="0" y="9.5" width="4.5" height="3.5" rx="1.75" fill="white"/>
      <rect x="4" y="13" width="13" height="5" rx="1.5" fill="white"/>
      <path d="M3.5 17.5 C1.5 17.5 0.5 18.5 0.5 19.5 C0.5 20.5 1.5 21.5 3.5 21.5" stroke="#5DFFF1" stroke-width="1.3" fill="none" stroke-linecap="round"/>
      <path d="M17.5 17.5 C19.5 17.5 20.5 18.5 20.5 19.5 C20.5 20.5 19.5 21.5 17.5 21.5" stroke="#5DFFF1" stroke-width="1.3" fill="none" stroke-linecap="round"/>
      <line x1="4.5" y1="13.5" x2="2" y2="10" stroke="#5DFFF1" stroke-width="1" stroke-linecap="round"/>
      <line x1="16.5" y1="13.5" x2="19" y2="10" stroke="#5DFFF1" stroke-width="1" stroke-linecap="round"/>
    </svg>`;
  } else {
    avatar.textContent = '👤';
  }

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${role === 'bot' ? 'bot-bubble' : 'user-bubble'}`;
  if (isError) bubble.classList.add('error-bubble');
  bubble.innerHTML = formatText(text);

  row.appendChild(avatar);
  row.appendChild(bubble);
  messages.appendChild(row);
  scrollToBottom();
}

function formatText(text) {
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>');
  return `<p>${html}</p>`;
}

function showTyping(show) {
  document.getElementById('typing-row').style.display = show ? 'flex' : 'none';
}

function setInputDisabled(disabled) {
  document.getElementById('chat-input').disabled = disabled;
  if (!disabled && currentUser && !currentUser.is_admin && currentUser.tokens <= 0) return;
  document.getElementById('send-btn').disabled = disabled;
}

function scrollToBottom() {
  const messages = document.getElementById('messages');
  requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
}

function showSources(sources) {
  const bar  = document.getElementById('sources-bar');
  const list = document.getElementById('sources-list');
  bar.style.display = 'flex';
  list.innerHTML = sources.map(s => `
    <a class="source-chip" href="${s.url}" target="_blank" rel="noopener" title="${escapeHtml(s.title)}">
      ▶ ${escapeHtml(s.title)}
    </a>
  `).join('');
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

// ─── Start ────────────────────────────────────────────
init();
