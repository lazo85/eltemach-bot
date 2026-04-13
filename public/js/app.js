/* ═══════════════════════════════════════════════════════
   ElTemAIch Bot — Frontend
   ═══════════════════════════════════════════════════════ */

const API = '/api/bot';
const HISTORY_KEY = 'temach_chat_history';
const MAX_TOKENS = 20; // for bar display reference (pack_20 size)

let chatHistory = [];
let isSending = false;
let kbReady = false;
let currentUser = null;

// ─── Auth helpers ─────────────────────────────────────
function getToken() { return localStorage.getItem('temach_token'); }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
}

// ─── Toast system ─────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

// ─── Token bar ────────────────────────────────────────
function updateTokenBar(tokens) {
  if (currentUser?.is_admin) return;
  const wrap  = document.getElementById('token-bar-wrap');
  const fill  = document.getElementById('token-bar-fill');
  const count = document.getElementById('token-bar-count');
  if (!wrap || !fill || !count) return;

  wrap.style.display = 'flex';
  const pct = Math.min(100, Math.max(0, (tokens / MAX_TOKENS) * 100));
  fill.style.width = pct + '%';
  fill.style.background = tokens <= 2
    ? 'var(--red)'
    : tokens <= 5
      ? '#f5a623'
      : 'var(--cyan)';
  count.textContent = `${tokens} token${tokens !== 1 ? 's' : ''}`;
}

// ─── LocalStorage history ─────────────────────────────
function saveHistory() {
  try {
    const msgs = document.getElementById('messages');
    const rows = [...msgs.querySelectorAll('.msg-row')];
    const saved = rows.map(row => ({
      role: row.classList.contains('user') ? 'user' : 'bot',
      html: row.querySelector('.msg-bubble')?.innerHTML || '',
      time: row.querySelector('.msg-time')?.textContent || ''
    }));
    // Keep only last 20 messages
    const trimmed = saved.slice(-20);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) { /* ignore quota errors */ }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved) || saved.length === 0) return;

    const messages = document.getElementById('messages');
    // Clear default welcome if we have history
    messages.innerHTML = '';

    saved.forEach(item => {
      const row = document.createElement('div');
      row.className = `msg-row ${item.role}`;

      const avatar = document.createElement('div');
      avatar.className = `msg-avatar ${item.role === 'bot' ? 'bot-avatar' : 'user-avatar'}`;
      if (item.role === 'bot') {
        avatar.innerHTML = botAvatarSVG();
      } else {
        avatar.textContent = '👤';
      }

      const content = document.createElement('div');
      content.className = 'msg-content';

      const bubble = document.createElement('div');
      bubble.className = `msg-bubble ${item.role === 'bot' ? 'bot-bubble' : 'user-bubble'}`;
      bubble.innerHTML = item.html;

      content.appendChild(bubble);

      if (item.time) {
        const timeEl = document.createElement('span');
        timeEl.className = 'msg-time';
        timeEl.textContent = item.time;
        content.appendChild(timeEl);
      }

      row.appendChild(avatar);
      row.appendChild(content);
      messages.appendChild(row);
    });

    scrollToBottom();
  } catch (e) {
    localStorage.removeItem(HISTORY_KEY);
  }
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  chatHistory = [];
  const messages = document.getElementById('messages');
  messages.innerHTML = '';
  // Re-add welcome message
  const row = document.createElement('div');
  row.className = 'msg-row bot';
  row.innerHTML = `
    <div class="msg-avatar bot-avatar">${botAvatarSVG()}</div>
    <div class="msg-content">
      <div class="msg-bubble bot-bubble">
        <p><strong>Soy ElTemAIch, tu asistente IA.</strong><br/>
        Pregúntame sobre temas de masculinidad, autodesarrollo, relaciones y psicología. Quiero ayudarte mi compa.</p>
      </div>
    </div>`;
  messages.appendChild(row);
  showToast('Conversación limpiada.', 'success');
}

// ─── Init ─────────────────────────────────────────────
async function init() {
  const token = getToken();
  if (!token) {
    window.location.href = '/login';
    return;
  }

  loadHistory();
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
    const buyLink = document.getElementById('buy-link');
    if (buyLink) buyLink.style.display = 'inline-block';
    tokenCount.textContent    = currentUser.is_admin ? '∞' : currentUser.tokens;

    // Token badge low state
    if (!currentUser.is_admin && currentUser.tokens <= 3) {
      tokenBadge.classList.add('low');
    }

    if (!currentUser.is_admin && currentUser.tokens <= 0) {
      document.getElementById('no-tokens-msg').style.display = 'block';
      document.getElementById('send-btn').disabled = true;
    }

    // Admin: ocultar costo de token y barra
    if (currentUser.is_admin) {
      const costEl = document.getElementById('send-token-cost');
      if (costEl) costEl.style.display = 'none';
    } else {
      updateTokenBar(currentUser.tokens);
      if (currentUser.tokens <= 3 && currentUser.tokens > 0) {
        showToast(`Te quedan ${currentUser.tokens} token${currentUser.tokens !== 1 ? 's' : ''}. Considera recargar.`, 'warning');
      }
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
  const tokenCount = document.getElementById('token-count');
  const tokenBadge = document.getElementById('token-badge');
  tokenCount.textContent = tokensLeft;

  if (tokensLeft <= 3) {
    tokenBadge.classList.add('low');
  } else {
    tokenBadge.classList.remove('low');
  }

  updateTokenBar(tokensLeft);

  if (tokensLeft <= 0) {
    document.getElementById('no-tokens-msg').style.display = 'block';
    document.getElementById('send-btn').disabled = true;
    showToast('Sin tokens disponibles. Recarga desde tu perfil.', 'error');
  } else if (tokensLeft === 1) {
    showToast('¡Último token! Recarga desde tu perfil.', 'warning');
  }

  // Update internal user object
  if (currentUser) currentUser.tokens = tokensLeft;
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
        showToast('Sin tokens disponibles. Recarga desde tu perfil.', 'error');
      } else {
        appendMessage('bot', data.error || 'Error desconocido', true);
        showToast('Error al procesar tu consulta.', 'error');
      }
    } else {
      chatHistory.push({ role: 'assistant', content: data.reply });
      appendMessage('bot', data.reply);
      if (data.tokensLeft !== null) updateTokenCount(data.tokensLeft);
    }
  } catch (err) {
    showTyping(false);
    appendMessage('bot', 'Error de conexión. Intenta de nuevo.', true);
    showToast('Error de conexión.', 'error');
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
function getTimestamp() {
  return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function botAvatarSVG() {
  return `<img src="/img/temach-avatar.png" alt="Temach" style="width:100%;height:100%;object-fit:cover;object-position:top center;"/>`;
}

function appendMessage(role, text, isError = false) {
  const messages = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  const avatar = document.createElement('div');
  avatar.className = `msg-avatar ${role === 'bot' ? 'bot-avatar' : 'user-avatar'}`;

  if (role === 'bot') {
    avatar.innerHTML = botAvatarSVG();
  } else {
    avatar.textContent = '👤';
  }

  const content = document.createElement('div');
  content.className = 'msg-content';

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${role === 'bot' ? 'bot-bubble' : 'user-bubble'}`;
  if (isError) bubble.classList.add('error-bubble');
  bubble.innerHTML = formatText(text);

  const timeEl = document.createElement('span');
  timeEl.className = 'msg-time';
  timeEl.textContent = getTimestamp();

  content.appendChild(bubble);
  content.appendChild(timeEl);
  row.appendChild(avatar);
  row.appendChild(content);
  messages.appendChild(row);
  scrollToBottom();

  // Persist to localStorage
  saveHistory();
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
