// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Client JavaScript (Phase 7)
//
// Frontend logic for the chat webapp. Handles MSAL auth, chat interaction,
// conversation management, and M365 context toggling.
// Exported as a template function that injects env config.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the client-side JavaScript as a string with config injected.
 */
export function getClientJS(config: {
  clientId: string;
  tenantId: string;
  redirectUri: string;
}): string {
  return `
// ─── MSAL Configuration ──────────────────────────────────────────────────────
const msalConfig = {
  auth: {
    clientId: "${config.clientId}",
    authority: "https://login.microsoftonline.com/${config.tenantId}",
    redirectUri: "${config.redirectUri}",
  },
  cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false }
};

const loginScopes = {
  scopes: [
    "openid", "profile", "email", "offline_access",
    "User.Read", "Chat.Read", "ChannelMessage.Read.All",
    "Sites.Read.All", "Tasks.Read", "Group.Read.All", "Team.ReadBasic.All"
  ]
};

let msalInstance = null;
let currentUser = null;
let currentConversationId = null;
let conversations = [];
let isLoading = false;
let activeContextSources = new Set();

// ─── App Initialization ──────────────────────────────────────────────────────
async function initApp() {
  // Wait for MSAL to be available (retry loop for slow CDNs)
  let retries = 0;
  while (typeof msal === "undefined" && retries < 10) {
    await new Promise(r => setTimeout(r, 300));
    retries++;
  }

  if (typeof msal === "undefined") {
    console.error("MSAL.js not found after retries. Domain might be blocked.");
    showLoginView();
    showLoginError("The authentication library could not be loaded. Please check your internet connection or disable any ad-blockers and refresh the page.");
    return;
  }

  try {
    msalInstance = new msal.PublicClientApplication(msalConfig);
    await msalInstance.initialize();

    // Handle redirect response (after login redirect)
    const response = await msalInstance.handleRedirectPromise();
    if (response) {
      await exchangeToken(response);
      return;
    }
  } catch (err) {
    console.error("MSAL initialization failed:", err);
    showLoginError("Failed to initialize authentication: " + err.message);
    return;
  }


  // Check if already authenticated via session cookie
  try {
    const res = await fetch("/api/webapp/auth/me");
    if (res.ok) {
      currentUser = await res.json();
      showChatView();
      loadConversations();
      return;
    }
  } catch (err) {
    // Silent catch if not logged in
  }

  showLoginView();
}

// ─── Authentication ──────────────────────────────────────────────────────────
async function login() {
  try {
    await msalInstance.loginRedirect(loginScopes);
  } catch (err) {
    console.error("Login redirect failed:", err);
    showLoginError(err.message || "Login failed. Please try again.");
  }
}

async function exchangeToken(msalResponse) {
  try {
    const res = await fetch("/api/webapp/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: msalResponse.code || msalResponse.accessToken,
        codeVerifier: msalResponse.codeVerifier || "",
        redirectUri: msalConfig.auth.redirectUri,
      }),
    });

    if (!res.ok) {
      // If server-side exchange fails, use the MSAL tokens directly
      // by attempting a simpler auth approach
      throw new Error("Token exchange failed");
    }

    currentUser = await res.json();
    // Use a small delay to ensure cookie is set before reloading/view swap
    setTimeout(() => {
      showChatView();
      loadConversations();
    }, 100);
  } catch (err) {
    // Fallback: try acquireTokenSilent and use the access token directly
    try {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        const silentResponse = await msalInstance.acquireTokenSilent({
          ...loginScopes,
          account: accounts[0]
        });
        // Use the access token to authenticate
        const res = await fetch("/api/webapp/auth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: silentResponse.accessToken,
            codeVerifier: "",
            redirectUri: msalConfig.auth.redirectUri,
          }),
        });
        if (res.ok) {
          currentUser = await res.json();
          showChatView();
          loadConversations();
          return;
        }
      }
    } catch {}
    console.error("Auth exchange failed:", err);
    showLoginError("Authentication failed. Please try again.");
  }
}

async function logout() {
  try {
    await fetch("/api/webapp/auth/logout", { method: "POST" });
  } catch {}
  currentUser = null;
  currentConversationId = null;
  conversations = [];
  msalInstance.logoutRedirect().catch(() => {});
  showLoginView();
}

// ─── Views ───────────────────────────────────────────────────────────────────
function showLoginView() {
  document.getElementById("app").innerHTML = \`
    <div class="login-screen">
      <div class="login-logo">
        <div class="login-badge">S-FX Technology</div>
        <h1><span>Arcadia</span></h1>
        <p>Your operational intelligence layer</p>
      </div>
      <button class="login-btn" onclick="login()">
        <svg viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
          <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
          <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
          <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
        </svg>
        Sign in with Microsoft
      </button>
      <div id="login-error" class="login-error" style="display:none"></div>
    </div>
  \`;
}

function showLoginError(msg) {
  const el = document.getElementById("login-error");
  if (el) { el.textContent = msg; el.style.display = "block"; }
}

function showChatView() {
  const initials = (currentUser.displayName || "?").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();

  document.getElementById("app").innerHTML = \`
    <button class="menu-toggle" onclick="toggleSidebar()">&#9776;</button>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-brand">
          <h2><span>Arcadia</span></h2>
        </div>
        <button class="new-chat-btn" onclick="newConversation()">+ New conversation</button>
      </div>
      <div class="sidebar-conversations" id="conv-list"></div>
      <div class="sidebar-footer">
        <div class="user-info">
          <div class="user-avatar">\${initials}</div>
          <span class="user-name">\${currentUser.displayName || "User"}</span>
        </div>
        <button class="logout-btn" onclick="logout()">Sign out</button>
      </div>
    </aside>
    <main class="chat-area">
      <div class="chat-messages" id="chat-messages">
        <div class="chat-empty">
          <h3>How can Arcadia help today?</h3>
          <p>Ask about your Teams conversations, SharePoint documents, Planner tasks, or anything else across your Microsoft 365 workspace.</p>
        </div>
      </div>
      <div class="chat-input-area">
        <div class="context-chips">
          <button class="context-chip" data-source="teams" onclick="toggleContext(this)">Teams</button>
          <button class="context-chip" data-source="chats" onclick="toggleContext(this)">Chats</button>
          <button class="context-chip" data-source="sharepoint" onclick="toggleContext(this)">SharePoint</button>
          <button class="context-chip" data-source="planner" onclick="toggleContext(this)">Planner</button>
        </div>
        <div class="input-wrapper">
          <textarea id="chat-input" placeholder="Ask Arcadia..." rows="1"
            onkeydown="handleKeyDown(event)" oninput="autoResize(this)"></textarea>
          <button class="send-btn" id="send-btn" onclick="sendMessage()" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    </main>
  \`;

  const input = document.getElementById("chat-input");
  input.addEventListener("input", () => {
    document.getElementById("send-btn").disabled = !input.value.trim();
  });
}

// ─── Conversations ───────────────────────────────────────────────────────────
async function loadConversations() {
  try {
    const res = await fetch("/api/webapp/conversations");
    if (res.ok) {
      const data = await res.json();
      conversations = data.conversations || [];
      renderConversationList();
    }
  } catch (err) {
    console.error("Failed to load conversations:", err);
  }
}

function renderConversationList() {
  const el = document.getElementById("conv-list");
  if (!el) return;

  if (conversations.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:12px">No conversations yet</div>';
    return;
  }

  el.innerHTML = conversations.map(c => {
    const isActive = c.id === currentConversationId;
    const date = new Date(c.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return \`<div class="conv-item \${isActive ? 'active' : ''}" onclick="loadConversation('\${c.id}')">
      <div class="conv-item-row">
        <div class="conv-item-title">\${escapeHtml(c.title)}</div>
        <button class="conv-item-delete" onclick="event.stopPropagation(); deleteConv('\${c.id}')" title="Delete">&times;</button>
      </div>
      <div class="conv-item-date">\${date} &middot; \${c.messageCount} messages</div>
    </div>\`;
  }).join("");
}

async function loadConversation(id) {
  currentConversationId = id;
  renderConversationList();

  try {
    const res = await fetch("/api/webapp/conversations/" + id);
    if (res.ok) {
      const data = await res.json();
      renderMessages(data.messages || []);
    }
  } catch (err) {
    console.error("Failed to load conversation:", err);
  }
}

function newConversation() {
  currentConversationId = null;
  renderConversationList();
  const el = document.getElementById("chat-messages");
  if (el) {
    el.innerHTML = \`<div class="chat-empty">
      <h3>How can Arcadia help today?</h3>
      <p>Ask about your Teams conversations, SharePoint documents, Planner tasks, or anything else across your Microsoft 365 workspace.</p>
    </div>\`;
  }
}

async function deleteConv(id) {
  try {
    await fetch("/api/webapp/conversations/" + id, { method: "DELETE" });
    conversations = conversations.filter(c => c.id !== id);
    if (currentConversationId === id) {
      currentConversationId = null;
      newConversation();
    }
    renderConversationList();
  } catch (err) {
    console.error("Failed to delete conversation:", err);
  }
}

// ─── Chat Messaging ──────────────────────────────────────────────────────────
function handleKeyDown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 150) + "px";
}

async function sendMessage() {
  const input = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message || isLoading) return;

  isLoading = true;
  input.value = "";
  input.style.height = "auto";
  document.getElementById("send-btn").disabled = true;

  // Clear empty state if present
  const messagesEl = document.getElementById("chat-messages");
  const empty = messagesEl.querySelector(".chat-empty");
  if (empty) empty.remove();

  // Show user message
  appendMessage("user", message);

  // Show typing indicator
  const typingEl = document.createElement("div");
  typingEl.className = "message assistant";
  typingEl.id = "typing-indicator";
  typingEl.innerHTML = \`<div class="message-label">Arcadia</div>
    <div class="message-content"><div class="typing-indicator">
      <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
    </div></div>\`;
  messagesEl.appendChild(typingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const res = await fetch("/api/webapp/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: currentConversationId,
        message,
        contextSources: Array.from(activeContextSources),
      }),
    });

    // Remove typing indicator
    const ti = document.getElementById("typing-indicator");
    if (ti) ti.remove();

    if (res.ok) {
      const data = await res.json();
      currentConversationId = data.conversationId;
      appendMessage("assistant", data.message);
      // Refresh conversation list
      await loadConversations();
    } else {
      const err = await res.json().catch(() => ({ error: "Something went wrong" }));
      appendMessage("assistant", "I ran into an issue: " + (err.error || "Unknown error. Please try again."));
    }
  } catch (err) {
    const ti = document.getElementById("typing-indicator");
    if (ti) ti.remove();
    appendMessage("assistant", "Connection error. Please check your network and try again.");
  }

  isLoading = false;
  document.getElementById("send-btn").disabled = false;
  document.getElementById("chat-input").focus();
}

function appendMessage(role, content) {
  const messagesEl = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "message " + role;

  const label = role === "user" ? "You" : "Arcadia";
  div.innerHTML = \`<div class="message-label">\${label}</div>
    <div class="message-content">\${role === "assistant" ? renderMarkdown(content) : escapeHtml(content)}</div>\`;

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessages(messages) {
  const el = document.getElementById("chat-messages");
  el.innerHTML = "";
  for (const msg of messages) {
    appendMessage(msg.role, msg.content);
  }
}

// ─── Context Chips ───────────────────────────────────────────────────────────
function toggleContext(btn) {
  const source = btn.dataset.source;
  if (activeContextSources.has(source)) {
    activeContextSources.delete(source);
    btn.classList.remove("active");
  } else {
    activeContextSources.add(source);
    btn.classList.add("active");
  }
}

// ─── Sidebar Toggle (Mobile) ─────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
}

// ─── Markdown Renderer (lightweight) ─────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  // Code blocks (must be before inline code)
  html = html.replace(/\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g, (_, code) =>
    '<pre><code>' + code.trim() + '</code></pre>');

  // Inline code
  html = html.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Unordered lists
  html = html.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\\/li>\\n?)+)/g, '<ul>$1</ul>');

  // Ordered lists
  html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (double newlines)
  html = html.replace(/\\n\\n/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p><\\/p>/g, '');
  html = html.replace(/<p>(<h[123]>)/g, '$1');
  html = html.replace(/(<\\/h[123]>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<pre>)/g, '$1');
  html = html.replace(/(<\\/pre>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\\/ul>)<\\/p>/g, '$1');

  // Single newlines to <br>
  html = html.replace(/\\n/g, '<br>');

  return html;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ─── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", initApp);
`;
}
