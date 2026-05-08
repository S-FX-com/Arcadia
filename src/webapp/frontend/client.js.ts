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
  version: string;
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
    "User.Read", "User.Read.All", "Chat.Read", "ChannelMessage.Read.All",
    "Sites.Read.All", "Tasks.Read", "Group.Read.All", "Team.ReadBasic.All",
    "Schedule.Read.All", "Schedule.ReadWrite.All", "TeamsActivity.Read",
    "Presence.Read", "Calendars.Read", "TeamMember.Read.All", "Files.Read", "People.Read"
  ]
};

let msalInstance = null;
let currentUser = null;
let currentConversationId = null;
let conversations = [];
let isLoading = false;
let activeContextSources = new Set();
let clients = [];
let activeClientId = null;
let imageMode = false;
let selectedImageModel = "quality";
let lastSyncTime = null;
let notificationPollTimer = null;
let lastAssistantMessageId = null;  // Phase 11: track for feedback

// Users who land here from the Teams bot's auth prompt carry ?source=teams.
// We remember that across the MSAL redirect so we can show a "go back to
// Teams" confirmation on return instead of dropping them into the chat UI.
const TEAMS_SOURCE_KEY = "arcadia_auth_source_teams";
function captureTeamsSource() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("source") === "teams") {
      sessionStorage.setItem(TEAMS_SOURCE_KEY, "1");
    }
  } catch {}
}
function consumeTeamsSource() {
  try {
    if (sessionStorage.getItem(TEAMS_SOURCE_KEY) === "1") {
      sessionStorage.removeItem(TEAMS_SOURCE_KEY);
      return true;
    }
  } catch {}
  return false;
}

// ─── App Initialization ──────────────────────────────────────────────────────

// Always-on timing log so users stuck on "Initializing..." can paste their
// console output and we can see exactly where the boot path hangs.
const BOOT_TS = Date.now();
function bootLog(stage, extra) {
  try {
    const ms = Date.now() - BOOT_TS;
    if (extra !== undefined) console.log(\`[arcadia-boot +\${ms}ms] \${stage}\`, extra);
    else console.log(\`[arcadia-boot +\${ms}ms] \${stage}\`);
  } catch {}
}

// Watchdog — if init never reaches a final view in 12 seconds, force the
// login screen with a visible "boot timed out" message so the user always
// has an escape hatch instead of staring at "Initializing..." forever.
let bootSettled = false;
function settleBoot(reason) {
  if (bootSettled) return;
  bootSettled = true;
  bootLog("settled:" + reason);
}
setTimeout(() => {
  if (bootSettled) return;
  bootLog("watchdog:timeout — forcing login view");
  try {
    showLoginView();
    showLoginError("Initialization timed out. Open browser DevTools \xBB Console and copy any [arcadia-boot] lines so we can see where it hung.");
  } catch (e) {
    console.error("[arcadia-boot] watchdog fallback also failed:", e);
  }
  settleBoot("watchdog");
}, 12000);

// Helper: race a promise against a timeout. The timeout produces a
// rejected promise tagged with the stage name so logs are useful.
function withTimeout(p, ms, stage) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout:" + stage + ":" + ms + "ms")), ms)),
  ]);
}

async function initApp() {
  bootLog("initApp:enter");
  captureTeamsSource();

  // Wait for MSAL to be available (retry loop for slow CDNs)
  let retries = 0;
  while (typeof msal === "undefined" && retries < 10) {
    await new Promise(r => setTimeout(r, 300));
    retries++;
  }
  bootLog("msal:loaded", { found: typeof msal !== "undefined", retries });

  if (typeof msal === "undefined") {
    console.error("MSAL.js not found after retries. Domain might be blocked.");
    showLoginView();
    showLoginError("The authentication library could not be loaded. Please check your internet connection or disable any ad-blockers and refresh the page.");
    settleBoot("msal-missing");
    return;
  }

  try {
    msalInstance = new msal.PublicClientApplication(msalConfig);
    bootLog("msal:initialize:start");
    await withTimeout(msalInstance.initialize(), 5000, "msal.initialize");
    bootLog("msal:initialize:done");

    // Handle redirect response (after login redirect). MSAL v2 can hang
    // here in some stale-cache scenarios; bound it.
    bootLog("msal:handleRedirectPromise:start");
    const response = await withTimeout(msalInstance.handleRedirectPromise(), 6000, "msal.handleRedirectPromise");
    bootLog("msal:handleRedirectPromise:done", { gotResponse: !!response });
    if (response) {
      await exchangeToken(response);
      settleBoot("msal-redirect");
      return;
    }
  } catch (err) {
    console.error("MSAL initialization failed:", err);
    showLoginView();
    showLoginError("Failed to initialize authentication: " + (err && err.message ? err.message : String(err)));
    settleBoot("msal-error");
    return;
  }


  // Check if already authenticated via session cookie
  try {
    bootLog("auth-me:start");
    const res = await withTimeout(fetch("/api/webapp/auth/me"), 6000, "auth-me");
    bootLog("auth-me:done", { status: res.status });
    if (res.ok) {
      currentUser = await res.json();
      if (consumeTeamsSource()) {
        showTeamsLinkedView();
        settleBoot("teams-linked");
        return;
      }
      showChatView();
      if (currentUser.needsReauth) showReauthBanner();
      loadConversations();
      loadClients();
      loadSyncStatus();
      loadClients();
      loadSyncStatus();
      settleBoot("authed");
      return;
    }
  } catch (err) {
    bootLog("auth-me:error", err && err.message ? err.message : String(err));
    // Silent catch if not logged in
  }

  showLoginView();
  settleBoot("login-view");
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
      if (consumeTeamsSource()) {
        showTeamsLinkedView();
      } else {
        showChatView();
        if (currentUser.needsReauth) showReauthBanner();
        loadConversations();
      }
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
          if (consumeTeamsSource()) {
            showTeamsLinkedView();
            return;
          }
          showChatView();
          if (currentUser.needsReauth) showReauthBanner();
          loadConversations();
          loadClients();
          loadSyncStatus();
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

// Confirmation view shown after a user authenticates because the Teams bot
// sent them here. They don't need the chat UI — they just need to know it
// worked and that they can go back to Teams.
function showTeamsLinkedView() {
  const name = (currentUser && currentUser.displayName) ? currentUser.displayName.split(" ")[0] : "";
  const greeting = name ? "You're all set, " + escapeHtml(name) + "." : "You're all set.";
  document.getElementById("app").innerHTML = \`
    <div class="login-screen">
      <div class="login-logo">
        <div class="login-badge">S-FX Technology</div>
        <h1><span>Arcadia</span></h1>
        <p>\${greeting}</p>
      </div>
      <div style="max-width:440px;text-align:center;color:var(--text-muted);line-height:1.6;margin-top:8px">
        <p>I now have permission to build your personal Arcadia persona. Head back to Microsoft Teams and say hi — I'll take it from there.</p>
        <p style="margin-top:16px;font-size:13px">You can close this tab, or <a href="#" onclick="event.preventDefault();showChatView();loadConversations();">open the Arcadia webapp</a> if you'd rather chat here.</p>
      </div>
    </div>
  \`;
}

function showChatView() {
  const initials = (currentUser.displayName || "?").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();

  document.getElementById("app").innerHTML = \`
    <button class="menu-toggle" onclick="toggleSidebar()">&#9776;</button>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-brand">
          <h2>S-FX <span>AI Assistant</span></h2>
        </div>
        <button class="new-chat-btn" onclick="newConversation()">+ New Conversation</button>
      </div>
      <div class="sidebar-conversations" id="sidebar-scroll" style="flex:1;overflow-y:auto;padding:4px 0">
        <div class="sidebar-section">
          <div class="sidebar-section-header">
            <span class="sidebar-section-label">Conversations</span>
          </div>
          <div id="conv-list"></div>
        </div>
        <div class="sidebar-section">
          <div class="sidebar-section-header">
            <span class="sidebar-section-label">Clients</span>
            <button class="sidebar-section-add" onclick="showAddClientWizard()" title="Add client">+</button>
          </div>
          <div id="client-list"></div>
        </div>
      </div>
      <div class="sidebar-footer" style="flex-direction:column;gap:8px;align-items:stretch">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div class="user-info">
            <div class="user-avatar">\${initials}</div>
            <span class="user-name">\${currentUser.displayName || "User"}</span>
          </div>
          <button class="logout-btn" onclick="logout()">Sign out</button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;border-top:1px solid var(--border-color)">
          <button class="sync-btn" id="sync-btn" onclick="triggerSync()">Sync M365</button>
          <span id="sync-time" style="font-size:11px;color:var(--text-muted)"></span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;border-top:1px solid var(--border-color)">
          <button class="sync-btn" onclick="showContextPanel()" style="flex:1">✦ My Context</button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;border-top:1px solid var(--border-color)">
          <button class="sync-btn" onclick="showProceduresPanel()" style="flex:1">⚙ Learned Procedures</button>
        </div>
        \${(currentUser.role === 'admin' || currentUser.role === 'manager') ? '<div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px;border-top:1px solid var(--border-color)"><button class=\\"sync-btn\\" onclick=\\"showAdminPanel()\\" style=\\"flex:1;background:var(--accent-color);color:#fff;border:none\\">&#x1F6E1; Admin Controls</button></div>' : ''}
        <div style="padding-top:6px;border-top:1px solid var(--border-color);text-align:right">
          <span style="font-size:10px;color:var(--text-muted);opacity:0.5;letter-spacing:0.3px">v${config.version}</span>
        </div>
      </div>
    </aside>
    <main class="chat-area">
      <div class="chat-messages" id="chat-messages">
        <div class="chat-empty">
          <h3>How can Arcadia help today?</h3>
          <p>Ask about your Teams channels, chats, SharePoint, Planner tasks — or select a Client for grounded intelligence.</p>
        </div>
      </div>
      <div class="chat-input-area">
        <div id="client-badge"></div>
        <div class="input-tabs">
          <button class="input-tab active" id="tab-chat" onclick="setInputMode('chat')">Chat</button>
          <button class="input-tab" id="tab-image" onclick="setInputMode('image')">Generate Image</button>
        </div>
        <div id="image-options" style="display:none;margin-bottom:8px">
          <select class="image-model-select" id="image-model-select" onchange="selectedImageModel=this.value">
            <option value="quality">Quality (FLUX.2 dev)</option>
            <option value="fast">Fast (FLUX.2 klein)</option>
            <option value="creative">Creative (Phoenix)</option>
          </select>
        </div>
        <div class="context-chips" id="context-chips">
          <button class="context-chip" data-source="teams" onclick="toggleContext(this)">Channels</button>
          <button class="context-chip" data-source="chats" onclick="toggleContext(this)">Chats</button>
          <button class="context-chip" data-source="sharepoint" onclick="toggleContext(this)">SharePoint</button>
          <button class="context-chip" data-source="planner" onclick="toggleContext(this)">Planner</button>
        </div>
        <div class="input-wrapper">
          <textarea id="chat-input" placeholder="Ask anything..." rows="1"
            onkeydown="handleKeyDown(event)" oninput="autoResize(this)"></textarea>
          <input id="image-input" type="text" placeholder="Describe your image..."
            style="display:none;flex:1;background:none;border:none;outline:none;color:var(--text-primary);font-size:14px"
            onkeydown="if(event.key==='Enter'){event.preventDefault();sendMessage();}"
            oninput="document.getElementById('send-btn').disabled=!this.value.trim()" />
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
      <p>Ask about your Teams channels, chats, SharePoint documents, Planner tasks, or anything else across your Microsoft 365 workspace.</p>
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

// ─── Input Mode ──────────────────────────────────────────────────────────────
function setInputMode(mode) {
  imageMode = mode === 'image';
  document.getElementById("tab-chat").classList.toggle("active", !imageMode);
  document.getElementById("tab-image").classList.toggle("active", imageMode);
  document.getElementById("chat-input").style.display = imageMode ? "none" : "";
  document.getElementById("image-input").style.display = imageMode ? "" : "none";
  document.getElementById("image-options").style.display = imageMode ? "" : "none";
  document.getElementById("context-chips").style.display = imageMode ? "none" : "";
  document.getElementById("send-btn").disabled = true;
  (imageMode ? document.getElementById("image-input") : document.getElementById("chat-input")).focus();
}

async function sendMessage() {
  const activeInput = imageMode ? document.getElementById("image-input") : document.getElementById("chat-input");
  const message = activeInput.value.trim();
  if (!message || isLoading) return;

  if (imageMode) {
    await sendImageRequest(message, activeInput);
    return;
  }

  const input = activeInput;

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
    const chatBody = {
      conversationId: currentConversationId,
      message,
      contextSources: Array.from(activeContextSources),
      ...(activeClientId ? { clientId: activeClientId } : {}),
    };

    let res = await fetch("/api/webapp/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody),
    });

    // Session expired — try silent MSAL re-auth once before giving up
    if (res.status === 401) {
      const reauthed = await trySilentReauth();
      if (reauthed) {
        res = await fetch("/api/webapp/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chatBody),
        });
      } else {
        const ti = document.getElementById("typing-indicator");
        if (ti) ti.remove();
        isLoading = false;
        document.getElementById("send-btn").disabled = false;
        showLoginView();
        return;
      }
    }

    // Remove typing indicator
    const ti = document.getElementById("typing-indicator");
    if (ti) ti.remove();

    if (res.ok) {
      const data = await res.json();
      currentConversationId = data.conversationId;
      if (data.messageId) lastAssistantMessageId = data.messageId;
      if (data.imageUrl) {
        appendImageMessage("assistant", data.message, data.imageUrl);
      } else {
        appendMessage("assistant", data.message, data.messageId, data.model);
      }
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

function appendMessage(role, content, messageId, model) {
  const messagesEl = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "message " + role;

  const label = role === "user" ? "You" : "Arcadia";
  const modelHtml = (role === "assistant" && model) ? \` <span class="message-model">\${escapeHtml(model)}</span>\` : "";
  const feedbackHtml = role === "assistant" ? \`
    <div class="message-feedback" data-msg-id="\${escapeHtml(messageId || '')}">
      <button class="feedback-btn" onclick="sendFeedback(this,'positive')" title="Good response">👍</button>
      <button class="feedback-btn" onclick="sendFeedback(this,'negative')" title="Not helpful">👎</button>
    </div>\` : "";
  div.innerHTML = \`<div class="message-label">\${label}\${modelHtml}</div>
    <div class="message-content">\${role === "assistant" ? renderMarkdown(content) : escapeHtml(content)}</div>\${feedbackHtml}\`;

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendFeedback(btn, signal) {
  if (!currentConversationId || !lastAssistantMessageId) return;
  const wrapper = btn.closest('.message-feedback');
  if (!wrapper || wrapper.dataset.sent) return;
  wrapper.dataset.sent = "1";
  wrapper.querySelectorAll('.feedback-btn').forEach(b => b.disabled = true);
  btn.textContent = signal === 'positive' ? '✅' : '❌';
  try {
    await fetch('/api/webapp/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: currentConversationId,
        messageId: wrapper.dataset.msgId || lastAssistantMessageId,
        signal,
      }),
    });
  } catch {}
}

function appendImageMessage(role, caption, imageUrl) {
  const messagesEl = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "message " + role;
  div.innerHTML = \`<div class="message-label">Arcadia</div>
    <div class="message-content">\${caption ? renderMarkdown(caption) + "<br>" : ""}
      <img src="\${escapeHtml(imageUrl)}" alt="Generated image"
        style="max-width:100%;border-radius:8px;margin-top:8px;display:block">
    </div>\`;
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

// ─── Silent Re-auth ──────────────────────────────────────────────────────────
function showReauthBanner() {
  if (document.getElementById("reauth-banner")) return;
  const chatArea = document.querySelector(".chat-area");
  if (!chatArea) return;
  const banner = document.createElement("div");
  banner.id = "reauth-banner";
  banner.className = "reauth-banner";
  banner.innerHTML = \`
    <span>🔑 <strong>New features available.</strong> Arcadia needs updated permissions for Teams Shifts and Updates.</span>
    <div class="reauth-banner-actions">
      <button class="reauth-grant-btn" onclick="grantNewScopes()">Grant access</button>
      <button class="reauth-dismiss-btn" onclick="dismissReauthBanner()" title="Dismiss">×</button>
    </div>\`;
  chatArea.insertBefore(banner, chatArea.firstChild);
}

function dismissReauthBanner() {
  const banner = document.getElementById("reauth-banner");
  if (banner) banner.remove();
}

async function grantNewScopes() {
  try {
    // Must use redirect/popup (not silent) to prompt consent for new scopes
    await msalInstance.loginRedirect(loginScopes);
  } catch (err) {
    console.error("Reauth redirect failed:", err);
  }
}

async function trySilentReauth() {
  try {
    const accounts = msalInstance ? msalInstance.getAllAccounts() : [];
    if (accounts.length === 0) return false;
    const silentResponse = await msalInstance.acquireTokenSilent({ ...loginScopes, account: accounts[0] });
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
      return true;
    }
  } catch {}
  return false;
}

// ─── Image Generation ────────────────────────────────────────────────────────
async function sendImageRequest(prompt, inputEl) {
  isLoading = true;
  inputEl.value = "";
  document.getElementById("send-btn").disabled = true;

  const messagesEl = document.getElementById("chat-messages");
  const empty = messagesEl.querySelector(".chat-empty");
  if (empty) empty.remove();

  appendMessage("user", "Generate image: " + prompt);

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
    const res = await fetch("/api/webapp/images/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: selectedImageModel }),
    });
    const ti = document.getElementById("typing-indicator");
    if (ti) ti.remove();

    if (res.ok) {
      const data = await res.json();
      const div = document.createElement("div");
      div.className = "message assistant";
      div.innerHTML = \`<div class="message-label">Arcadia</div>
        <div class="message-content">
          <div class="generated-image-wrap">
            <img src="\${escapeHtml(data.url)}" alt="Generated image">
            <a class="img-download" href="\${escapeHtml(data.url)}" download="arcadia-image.png" target="_blank">Download</a>
          </div>
        </div>\`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      appendMessage("assistant", "Image generation failed. Please try again.");
    }
  } catch (err) {
    const ti = document.getElementById("typing-indicator");
    if (ti) ti.remove();
    appendMessage("assistant", "Connection error during image generation.");
  }

  isLoading = false;
  document.getElementById("send-btn").disabled = false;
  inputEl.focus();
}

// ─── Clients ─────────────────────────────────────────────────────────────────
async function loadClients() {
  try {
    const res = await fetch("/api/webapp/clients");
    if (res.ok) {
      const data = await res.json();
      clients = data.clients || [];
      renderClientList();
    }
  } catch (err) {
    console.error("Failed to load clients:", err);
  }
}

function renderClientList() {
  const el = document.getElementById("client-list");
  if (!el) return;

  if (clients.length === 0) {
    el.innerHTML = '<div style="padding:6px 20px;color:var(--text-muted);font-size:12px">No clients yet</div>';
    return;
  }

  el.innerHTML = clients.map(c => {
    const isActive = c.id === activeClientId;
    const convCount = conversations.filter(cv => cv.clientId === c.id).length;
    return \`<div class="client-item \${isActive ? 'active' : ''}" onclick="selectClient('\${c.id}')">
      <div class="client-status-dot \${c.indexStatus}"></div>
      <div class="client-item-info">
        <div class="client-item-name">\${escapeHtml(c.name)}</div>
        \${convCount > 0 ? \`<div class="client-item-meta">\${convCount} conversation\${convCount !== 1 ? 's' : ''}</div>\` : ''}
      </div>
    </div>\`;
  }).join("");
}

function selectClient(id) {
  if (activeClientId === id) {
    activeClientId = null;
  } else {
    activeClientId = id;
  }
  renderClientList();
  renderConversationList();
  updateClientBadge();
  newConversation();
}

function updateClientBadge() {
  const badge = document.getElementById("client-badge");
  if (!badge) return;
  if (!activeClientId) {
    badge.innerHTML = "";
    return;
  }
  const client = clients.find(c => c.id === activeClientId);
  if (!client) { badge.innerHTML = ""; return; }
  badge.innerHTML = \`<div class="client-context-badge" style="border-color:\${escapeHtml(client.color)};color:\${escapeHtml(client.color)}">
    <span>●</span> \${escapeHtml(client.name)}
    <button onclick="selectClient('\${escapeHtml(client.id)}')" style="background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 2px">&times;</button>
  </div>\`;
}

// ─── Add Client Wizard ────────────────────────────────────────────────────────
let wizardStep = 1;
let wizardData = {};
let wizardSelectedSources = [];

function showAddClientWizard() {
  wizardStep = 1;
  wizardData = {};
  wizardSelectedSources = [];
  renderWizardStep();
}

function renderWizardStep() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "wizard-overlay";

  if (wizardStep === 1) {
    overlay.innerHTML = \`<div class="modal">
      <h3>New Client — Step 1 of 3</h3>
      <div class="modal-field">
        <label>Client Name</label>
        <input id="wiz-name" type="text" placeholder="e.g. Acme Corp" value="\${escapeHtml(wizardData.name || '')}" />
      </div>
      <div class="modal-field">
        <label>Description (optional)</label>
        <textarea id="wiz-desc" rows="3" placeholder="What is this client about?">\${escapeHtml(wizardData.description || '')}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeWizard()">Cancel</button>
        <button class="btn-primary" onclick="wizardNext()">Next →</button>
      </div>
    </div>\`;
  } else if (wizardStep === 2) {
    overlay.innerHTML = \`<div class="modal">
      <h3>New Client — Step 2 of 3</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Select M365 sources to link to this client.</p>
      <div class="source-list" id="source-picker">
        <div style="color:var(--text-muted);font-size:12px;padding:8px">Loading your M365 sources...</div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="wizardBack()">← Back</button>
        <button class="btn-primary" onclick="wizardNext()">Next →</button>
      </div>
    </div>\`;
    loadWizardSources();
  } else if (wizardStep === 3) {
    const sourceCount = wizardSelectedSources.length;
    overlay.innerHTML = \`<div class="modal">
      <h3>New Client — Step 3 of 3</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
        Ready to create <strong>\${escapeHtml(wizardData.name)}</strong> with \${sourceCount} source\${sourceCount !== 1 ? 's' : ''}.
        Indexing will start immediately.
      </p>
      \${wizardSelectedSources.map(s => \`<div style="font-size:12px;color:var(--text-secondary);padding:3px 0">• \${escapeHtml(s.sourceName)} (\${escapeHtml(s.sourceType)})</div>\`).join('')}
      \${sourceCount === 0 ? '<div style="font-size:12px;color:var(--warning);margin-top:8px">No sources selected — you can add them later.</div>' : ''}
      <div class="modal-actions">
        <button class="btn-secondary" onclick="wizardBack()">← Back</button>
        <button class="btn-primary" id="wiz-create-btn" onclick="wizardCreate()">Create Client</button>
      </div>
    </div>\`;
  }

  document.body.appendChild(overlay);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadWizardSources() {
  const picker = document.getElementById("source-picker");
  if (!picker) return;

  const sources = [];
  let anyError = false;
  try {
    const [teamsRes, chatsRes, spRes, shiftsRes, updatesRes, calRes, odRes, peopleRes] = await Promise.allSettled([
      fetchWithTimeout("/api/webapp/context/teams", 12000),
      fetchWithTimeout("/api/webapp/context/chats", 12000),
      fetchWithTimeout("/api/webapp/context/sharepoint", 12000),
      fetchWithTimeout("/api/webapp/context/shifts", 15000),
      fetchWithTimeout("/api/webapp/context/updates", 12000),
      fetchWithTimeout("/api/webapp/context/calendar", 12000),
      fetchWithTimeout("/api/webapp/context/onedrive", 12000),
      fetchWithTimeout("/api/webapp/context/people", 12000),
    ]);

    if (teamsRes.status === 'fulfilled' && teamsRes.value.ok) {
      const data = await teamsRes.value.json();
      for (const t of (data.teams || []).slice(0, 10)) {
        sources.push({ sourceType: 'team', sourceId: t.id, sourceName: t.displayName, icon: '👥' });
      }
    } else if (teamsRes.status === 'rejected' || (teamsRes.status === 'fulfilled' && !teamsRes.value.ok)) {
      anyError = true;
    }

    if (chatsRes.status === 'fulfilled' && chatsRes.value.ok) {
      const data = await chatsRes.value.json();
      for (const c of (data.chats || []).slice(0, 8)) {
        sources.push({ sourceType: 'chat', sourceId: c.id, sourceName: c.topic || c.chatType, icon: '💬' });
      }
    } else if (chatsRes.status === 'rejected' || (chatsRes.status === 'fulfilled' && !chatsRes.value.ok)) {
      anyError = true;
    }

    if (spRes.status === 'fulfilled' && spRes.value.ok) {
      const data = await spRes.value.json();
      for (const s of (data.sites || []).slice(0, 6)) {
        sources.push({ sourceType: 'sharepoint-site', sourceId: s.id, sourceName: s.displayName, icon: '📁' });
      }
    } else if (spRes.status === 'rejected' || (spRes.status === 'fulfilled' && !spRes.value.ok)) {
      anyError = true;
    }

    if (shiftsRes.status === 'fulfilled' && shiftsRes.value.ok) {
      const data = await shiftsRes.value.json();
      for (const s of (data.shifts || []).slice(0, 8)) {
        const start = new Date(s.startDateTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        sources.push({ sourceType: 'teams-shift', sourceId: s.id, sourceName: \`\${s.displayName} (\${start})\`, icon: '🗓️' });
      }
    }

    if (updatesRes.status === 'fulfilled' && updatesRes.value.ok) {
      const data = await updatesRes.value.json();
      for (const u of (data.updates || []).slice(0, 6)) {
        sources.push({ sourceType: 'teams-update', sourceId: u.id, sourceName: u.title, icon: '📋' });
      }
    }

    if (calRes.status === 'fulfilled' && calRes.value.ok) {
      const data = await calRes.value.json();
      for (const e of (data.events || []).slice(0, 8)) {
        const start = new Date(e.startDateTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        sources.push({ sourceType: 'calendar-event', sourceId: e.id, sourceName: \`\${e.subject} (\${start})\`, icon: '📅' });
      }
    }

    if (odRes.status === 'fulfilled' && odRes.value.ok) {
      const data = await odRes.value.json();
      for (const f of (data.items || []).slice(0, 6)) {
        sources.push({ sourceType: 'onedrive-item', sourceId: f.id, sourceName: f.name, icon: '💾' });
      }
    }

    if (peopleRes.status === 'fulfilled' && peopleRes.value.ok) {
      const data = await peopleRes.value.json();
      for (const p of (data.people || []).slice(0, 6)) {
        const detail = p.jobTitle ? \` — \${p.jobTitle}\` : '';
        sources.push({ sourceType: 'person', sourceId: p.id, sourceName: \`\${p.displayName}\${detail}\`, icon: '🧑' });
      }
    }
  } catch {
    anyError = true;
  }

  if (sources.length === 0) {
    const msg = anyError
      ? 'Could not reach M365. Check your connection or re-authenticate.'
      : 'No M365 sources found. Ensure you have the right permissions.';
    picker.innerHTML = \`<div style="color:var(--text-muted);font-size:12px;padding:8px">\${msg}</div>\`;
    return;
  }

  picker.innerHTML = sources.map((s, i) => {
    const isSelected = wizardSelectedSources.some(ws => ws.sourceId === s.sourceId);
    return \`<div class="source-item \${isSelected ? 'selected' : ''}" onclick="toggleWizardSource(\${i})" data-idx="\${i}"
      data-source='\${escapeHtml(JSON.stringify(s))}'>
      <span class="source-item-icon">\${s.icon}</span>
      <span class="source-item-name">\${escapeHtml(s.sourceName)}</span>
      <span class="source-item-type">\${escapeHtml(s.sourceType)}</span>
    </div>\`;
  }).join('');

  // Store sources on picker for retrieval
  picker._sources = sources;
}

function toggleWizardSource(idx) {
  const picker = document.getElementById("source-picker");
  if (!picker || !picker._sources) return;
  const source = picker._sources[idx];
  const existIdx = wizardSelectedSources.findIndex(s => s.sourceId === source.sourceId);
  if (existIdx >= 0) {
    wizardSelectedSources.splice(existIdx, 1);
  } else {
    wizardSelectedSources.push(source);
  }
  // Re-render items
  const items = picker.querySelectorAll('.source-item');
  items.forEach((item, i) => {
    const isSelected = wizardSelectedSources.some(s => s.sourceId === picker._sources[i].sourceId);
    item.classList.toggle('selected', isSelected);
  });
}

function wizardNext() {
  if (wizardStep === 1) {
    const name = document.getElementById("wiz-name")?.value.trim();
    if (!name) { alert("Please enter a client name."); return; }
    wizardData.name = name;
    wizardData.description = document.getElementById("wiz-desc")?.value.trim() || "";
  }
  wizardStep++;
  closeWizard();
  renderWizardStep();
}

function wizardBack() {
  wizardStep--;
  closeWizard();
  renderWizardStep();
}

function closeWizard() {
  const overlay = document.getElementById("wizard-overlay");
  if (overlay) overlay.remove();
}

async function wizardCreate() {
  const btn = document.getElementById("wiz-create-btn");
  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/api/webapp/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: wizardData.name, description: wizardData.description }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert("Failed to create client: " + (err.error || "Unknown error"));
      if (btn) btn.disabled = false;
      return;
    }
    const data = await res.json();
    const clientId = data.client.id;

    // Add selected sources
    for (const source of wizardSelectedSources) {
      await fetch(\`/api/webapp/clients/\${clientId}/sources\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source),
      }).catch(() => {});
    }

    // Trigger index
    await fetch(\`/api/webapp/clients/\${clientId}/index\`, { method: "POST" }).catch(() => {});

    closeWizard();
    await loadClients();

    // Select the new client
    activeClientId = clientId;
    renderClientList();
    updateClientBadge();
    newConversation();
  } catch (err) {
    alert("An error occurred: " + err.message);
    if (btn) btn.disabled = false;
  }
}

// ─── M365 Sync ───────────────────────────────────────────────────────────────
async function loadSyncStatus() {
  try {
    const res = await fetch("/api/webapp/sync/status");
    if (res.ok) {
      const data = await res.json();
      if (data.lastSync) {
        lastSyncTime = new Date(data.lastSync);
        updateSyncTimeDisplay();
      }
    }
  } catch {}
}

function updateSyncTimeDisplay() {
  const el = document.getElementById("sync-time");
  if (!el || !lastSyncTime) return;
  const diffMs = Date.now() - lastSyncTime.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) el.textContent = "Synced just now";
  else if (diffMin < 60) el.textContent = \`Synced \${diffMin}m ago\`;
  else el.textContent = \`Synced \${Math.floor(diffMin / 60)}h ago\`;
}

async function triggerSync() {
  const btn = document.getElementById("sync-btn");
  if (!btn || btn.dataset.syncing) return;
  btn.dataset.syncing = "1";
  btn.className = "sync-btn syncing";
  btn.textContent = "Syncing...";

  try {
    const res = await fetch("/api/webapp/sync", { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      lastSyncTime = new Date(data.lastSync);
      btn.className = "sync-btn synced";
      btn.textContent = "✓ Synced";
      updateSyncTimeDisplay();
      setTimeout(() => {
        if (btn) { btn.className = "sync-btn"; btn.textContent = "Sync M365"; }
      }, 3000);
    } else {
      btn.className = "sync-btn error";
      btn.textContent = "Sync Failed — Retry";
    }
  } catch {
    btn.className = "sync-btn error";
    btn.textContent = "Sync Failed — Retry";
  }

  delete btn.dataset.syncing;
}

// ─── Learned Procedures Panel ─────────────────────────────────────────────────

// ─── Operating Context (Phase 17) ─────────────────────────────────────────────

async function showContextPanel() {
  let charter = null;
  let insights = null;
  let maxBytes = 2048;
  let reviewIntervalDays = 90;
  try {
    const res = await fetch('/api/webapp/charter');
    if (res.ok) {
      const d = await res.json();
      charter = d.charter || null;
      insights = d.insights || null;
      if (typeof d.maxBytes === 'number') maxBytes = d.maxBytes;
      if (typeof d.reviewIntervalDays === 'number') reviewIntervalDays = d.reviewIntervalDays;
    }
  } catch {}

  const initialContent = charter && charter.content ? charter.content : '';
  const lastReviewed = charter && charter.lastReviewedAt ? new Date(charter.lastReviewedAt) : null;
  const daysSinceReview = lastReviewed ? Math.floor((Date.now() - lastReviewed.getTime()) / 86400000) : null;
  const isStale = daysSinceReview === null ? !!charter : daysSinceReview > reviewIntervalDays;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'context-overlay';

  // Side panel: render whatever we have inferred so the user can see it and
  // decide what to correct via their own context. When nothing is inferred
  // yet, say so plainly rather than padding with empty fields.
  let inferredHtml;
  if (!insights) {
    inferredHtml = '<p style="color:var(--text-muted);font-size:13px;margin:0">Arcadia hasn\\'t built a profile yet. Once you have a few conversations, it\\'ll start inferring how you work — and you can correct it here.</p>';
  } else {
    const rows = [];
    if (insights.communicationStyle && insights.communicationStyle.summary) {
      rows.push('<div><strong>Communication style:</strong> ' + escapeHtml(insights.communicationStyle.summary) + '</div>');
    }
    const focus = []
      .concat((insights.focusAreas && insights.focusAreas.primary) || [])
      .concat((insights.focusAreas && insights.focusAreas.recent) || []);
    if (focus.length) rows.push('<div><strong>Focus areas:</strong> ' + focus.map(escapeHtml).join(', ') + '</div>');
    if (insights.workingPatterns && insights.workingPatterns.activeHours) {
      rows.push('<div><strong>Active hours:</strong> ' + escapeHtml(insights.workingPatterns.activeHours) + '</div>');
    }
    if (insights.workingPatterns && insights.workingPatterns.responseStyle) {
      rows.push('<div><strong>Working style:</strong> ' + escapeHtml(insights.workingPatterns.responseStyle) + '</div>');
    }
    inferredHtml = rows.length
      ? '<div style="display:flex;flex-direction:column;gap:6px;font-size:12px">' + rows.join('') + '</div>'
      : '<p style="color:var(--text-muted);font-size:13px;margin:0">Arcadia has a profile row but no concrete insights yet.</p>';
  }

  let staleBanner = '';
  if (isStale) {
    const msg = daysSinceReview === null
      ? 'You haven\\'t confirmed this is still accurate. Review and save when ready.'
      : 'Last reviewed ' + daysSinceReview + ' days ago. Worth a quick check.';
    staleBanner = '<div style="padding:8px 12px;background:rgba(255,180,0,0.12);border:1px solid rgba(255,180,0,0.4);border-radius:6px;font-size:12px;margin-bottom:12px">' + msg + '</div>';
  }

  const versionLine = charter
    ? 'v' + charter.version + ' · saved ' + new Date(charter.updatedAt).toLocaleDateString() + (lastReviewed ? ' · reviewed ' + lastReviewed.toLocaleDateString() : '')
    : 'No charter yet — start writing below.';

  overlay.innerHTML =
    '<div class="modal" style="max-width:880px;max-height:85vh;overflow:hidden;display:flex;flex-direction:column">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
        '<h3 style="margin:0">✦ My Operating Context</h3>' +
        '<button class="btn-secondary" onclick="closeContextPanel()">Close</button>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">' +
        'Tell Arcadia how you work, what to nudge you about, and what to leave alone. This is the EA brief — Arcadia treats it as ground truth and defers to it when it conflicts with what it has inferred. Markdown is fine. Cap: ' + maxBytes + ' bytes.' +
      '</p>' +
      staleBanner +
      '<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;flex:1;min-height:0">' +
        '<div style="display:flex;flex-direction:column;min-height:0">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
            '<strong style="font-size:12px">Your context (Markdown)</strong>' +
            '<span id="charter-counter" style="font-size:11px;color:var(--text-muted)"></span>' +
          '</div>' +
          '<textarea id="charter-content" style="flex:1;min-height:280px;padding:10px;font-family:ui-monospace,Menlo,monospace;font-size:13px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;resize:vertical;color:var(--text-primary)">' + escapeHtml(initialContent) + '</textarea>' +
          '<div style="display:flex;gap:8px;margin-top:10px;align-items:center">' +
            '<button class="btn-secondary" id="charter-save-btn" onclick="saveCharter()">Save</button>' +
            (charter ? '<button class="btn-secondary" onclick="reviewCharter()">Still accurate</button>' : '') +
            '<span id="charter-status" style="font-size:11px;color:var(--text-muted);margin-left:auto">' + escapeHtml(versionLine) + '</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--border-color);padding-left:16px">' +
          '<strong style="font-size:12px;margin-bottom:6px">What Arcadia infers about you</strong>' +
          '<p style="font-size:11px;color:var(--text-muted);margin:0 0 10px">Read-only. Built from your message history. If anything here is wrong, fix it on the left — your context wins.</p>' +
          '<div style="overflow-y:auto;flex:1">' + inferredHtml + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  const ta = document.getElementById('charter-content');
  const counter = document.getElementById('charter-counter');
  const updateCounter = () => {
    const bytes = new TextEncoder().encode(ta.value).byteLength;
    const over = bytes > maxBytes;
    counter.textContent = bytes + ' / ' + maxBytes + ' bytes';
    counter.style.color = over ? 'var(--danger-color, #f44336)' : 'var(--text-muted)';
    document.getElementById('charter-save-btn').disabled = over;
  };
  ta.addEventListener('input', updateCounter);
  updateCounter();
}

function closeContextPanel() {
  const el = document.getElementById('context-overlay');
  if (el) el.remove();
}

async function saveCharter() {
  const ta = document.getElementById('charter-content');
  const status = document.getElementById('charter-status');
  if (!ta || !status) return;
  status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/webapp/charter', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: ta.value }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      status.textContent = 'Save failed: ' + (txt || res.status);
      return;
    }
    closeContextPanel();
    showToast('Operating context saved');
    showContextPanel();
  } catch (err) {
    status.textContent = 'Save failed: ' + (err && err.message ? err.message : 'unknown error');
  }
}

async function reviewCharter() {
  try {
    const res = await fetch('/api/webapp/charter/review', { method: 'POST' });
    if (!res.ok) return;
    closeContextPanel();
    showToast('Marked as still accurate');
    showContextPanel();
  } catch {}
}

async function showProceduresPanel() {
  // Load procedures and user intelligence in parallel
  let procedures = [];
  let intelligence = null;
  try {
    const [pRes, iRes] = await Promise.all([
      fetch('/api/webapp/procedures'),
      fetch('/api/webapp/intelligence'),
    ]);
    if (pRes.ok) { const d = await pRes.json(); procedures = d.procedures || []; }
    if (iRes.ok) { const d = await iRes.json(); intelligence = d.intelligence; }
  } catch {}

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'procedures-overlay';

  const statusBadge = (s) => {
    const colors = { candidate: '#888', active: '#4CAF50', retired: '#f44336' };
    return \`<span style="background:\${colors[s]||'#888'};color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600">\${s}</span>\`;
  };
  const scoreBar = (score) => {
    const pct = Math.round(score * 100);
    const filled = Math.round(pct / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    return \`<span style="font-family:monospace;font-size:12px">\${bar} \${pct}%</span>\`;
  };

  const procedureRows = procedures.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px">No procedures yet. They appear as Arcadia learns from your interactions.</p>'
    : procedures.map(p => \`
      <div class="proc-row" id="proc-\${escapeHtml(p.id)}" style="border:1px solid var(--border-color);border-radius:8px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <strong style="flex:1;font-size:13px">\${escapeHtml(p.name)}</strong>
          \${statusBadge(p.status)}
          \${scoreBar(p.score)}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">\${escapeHtml(p.description)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
          Keywords: <code>\${escapeHtml(p.triggerPattern)}</code> &nbsp;·&nbsp;
          Uses: \${p.uses} &nbsp;·&nbsp; Scope: \${escapeHtml(p.scope)}
        </div>
        <details style="font-size:12px;margin-bottom:6px">
          <summary style="cursor:pointer;color:var(--text-muted)">Content</summary>
          <div style="margin-top:6px;padding:8px;background:var(--bg-secondary);border-radius:4px;white-space:pre-wrap">\${escapeHtml(p.content)}</div>
        </details>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          \${p.status !== 'active' ? \`<button class="btn-secondary" style="font-size:11px;padding:3px 8px" onclick="promoteProcedure('\${escapeHtml(p.id)}')">Promote</button>\` : ''}
          \${p.status !== 'retired' ? \`<button class="btn-secondary" style="font-size:11px;padding:3px 8px" onclick="retireProcedure('\${escapeHtml(p.id)}')">Retire</button>\` : ''}
          <button class="btn-secondary" style="font-size:11px;padding:3px 8px" onclick="viewProcedureHistory('\${escapeHtml(p.id)}','\${escapeHtml(p.name)}')">History</button>
        </div>
      </div>\`).join('');

  const intelSection = intelligence ? \`
    <div style="margin-top:16px;border-top:1px solid var(--border-color);padding-top:12px">
      <h4 style="margin:0 0 8px">User Intelligence Profile</h4>
      <div style="font-size:12px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div><strong>Response length:</strong> \${escapeHtml(intelligence.preferredResponseLength)}</div>
        <div><strong>Format:</strong> \${escapeHtml(intelligence.preferredFormat)}</div>
        <div><strong>Timezone:</strong> \${escapeHtml(intelligence.timezone || '—')}</div>
        <div><strong>Positive rate:</strong> \${Math.round((intelligence.positiveRate || 0) * 100)}%</div>
        \${intelligence.communicationStyle ? \`<div style="grid-column:1/-1"><strong>Style:</strong> \${escapeHtml(intelligence.communicationStyle)}</div>\` : ''}
        \${intelligence.expertiseAreas?.length ? \`<div style="grid-column:1/-1"><strong>Expertise:</strong> \${intelligence.expertiseAreas.map(escapeHtml).join(', ')}</div>\` : ''}
        \${intelligence.correctionPatterns?.length ? \`<div style="grid-column:1/-1"><strong>Corrections noted:</strong> \${intelligence.correctionPatterns.map(escapeHtml).join('; ')}</div>\` : ''}
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">Last updated: \${intelligence.lastUpdated ? new Date(intelligence.lastUpdated).toLocaleDateString() : '—'} (v\${intelligence.intelligenceVersion})</div>
    </div>\` : '';

  overlay.innerHTML = \`<div class="modal" style="max-width:640px;max-height:80vh;overflow-y:auto">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h3 style="margin:0">⚙ Learned Procedures</h3>
      <button class="btn-secondary" onclick="closeProceduresPanel()">Close</button>
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">
      Arcadia learns reusable approaches from your interactions.
      Candidates are invisible until promoted. Active procedures inject guidance into every matching response.
    </p>
    \${procedureRows}
    \${intelSection}
  </div>\`;

  document.body.appendChild(overlay);
}

function closeProceduresPanel() {
  const el = document.getElementById('procedures-overlay');
  if (el) el.remove();
}

async function promoteProcedure(id) {
  await fetch(\`/api/webapp/procedures/\${id}/promote\`, { method: 'POST' }).catch(() => {});
  closeProceduresPanel();
  showProceduresPanel();
}

async function retireProcedure(id) {
  await fetch(\`/api/webapp/procedures/\${id}/retire\`, { method: 'POST' }).catch(() => {});
  closeProceduresPanel();
  showProceduresPanel();
}

async function viewProcedureHistory(id, name) {
  let history = [];
  try {
    const res = await fetch(\`/api/webapp/procedures/\${id}/history\`);
    if (res.ok) { const d = await res.json(); history = d.history || []; }
  } catch {}

  const existing = document.getElementById('procedures-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'procedures-overlay';

  const rows = history.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px">No history yet.</p>'
    : history.map(h => \`<div style="padding:6px 0;border-bottom:1px solid var(--border-color);font-size:12px">
        <strong>\${escapeHtml(h.action)}</strong>
        \${h.fromStatus ? \` \${escapeHtml(h.fromStatus)} → \${escapeHtml(h.toStatus)}\` : ''}
        \${h.fromScore != null ? \` | score \${h.fromScore.toFixed(2)} → \${(h.toScore||0).toFixed(2)}\` : ''}
        \${h.reason ? \` | \${escapeHtml(h.reason)}\` : ''}
        <span style="color:var(--text-muted);margin-left:8px">\${new Date(h.createdAt).toLocaleDateString()}</span>
      </div>\`).join('');

  overlay.innerHTML = \`<div class="modal" style="max-width:500px;max-height:70vh;overflow-y:auto">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h3 style="margin:0">History: \${escapeHtml(name)}</h3>
      <button class="btn-secondary" onclick="closeProceduresPanel()">Close</button>
    </div>
    \${rows}
  </div>\`;
  document.body.appendChild(overlay);
}

// ─── Admin Controls Panel ─────────────────────────────────────────────────────

let adminCurrentTab = 'users';

async function showAdminPanel() {
  const existing = document.getElementById('admin-overlay');
  if (existing) { existing.remove(); return; }

  const isAdminUser = currentUser.role === 'admin';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'admin-overlay';
  overlay.innerHTML = \`
    <div class="modal" style="max-width:860px;max-height:88vh;overflow:hidden;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h3 style="margin:0">🛡 Admin Controls</h3>
        <button class="btn-secondary" onclick="closeAdminPanel()">Close</button>
      </div>
      <div class="admin-tabs" id="admin-tabs">
        <button class="admin-tab active" onclick="switchAdminTab('users',this)">Users &amp; Roles</button>
        <button class="admin-tab" onclick="switchAdminTab('shifts',this)">Shift Templates</button>
        <button class="admin-tab" onclick="switchAdminTab('reports',this)">Staff Reports</button>
        \${isAdminUser ? '<button class="admin-tab" onclick="switchAdminTab(&#39;audit&#39;,this)">Audit Log</button>' : ''}
      </div>
      <div id="admin-content" style="flex:1;overflow-y:auto;padding-top:12px">
        <div style="color:var(--text-muted);font-size:13px">Loading…</div>
      </div>
    </div>
  \`;
  document.body.appendChild(overlay);
  adminCurrentTab = 'users';
  await loadAdminTab('users');
}

function closeAdminPanel() {
  const el = document.getElementById('admin-overlay');
  if (el) el.remove();
}

async function switchAdminTab(tab, btn) {
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  adminCurrentTab = tab;
  await loadAdminTab(tab);
}

async function loadAdminTab(tab) {
  const content = document.getElementById('admin-content');
  if (!content) return;
  content.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">Loading…</div>';
  try {
    if (tab === 'users') {
      const res = await fetch('/api/webapp/admin/users');
      const data = res.ok ? await res.json() : { users: [] };
      renderAdminUsersTab(data.users || []);
    } else if (tab === 'shifts') {
      const res = await fetch('/api/webapp/admin/shifts/templates');
      const data = res.ok ? await res.json() : { templates: [] };
      renderAdminShiftsTab(data.templates || []);
    } else if (tab === 'reports') {
      renderAdminReportsTab();
    } else if (tab === 'audit') {
      const res = await fetch('/api/webapp/admin/audit-log?limit=50');
      const data = res.ok ? await res.json() : { entries: [] };
      renderAdminAuditTab(data);
    }
  } catch (err) {
    content.innerHTML = \`<div style="color:var(--error-color);font-size:13px">Failed to load: \${err.message}</div>\`;
  }
}

function renderAdminUsersTab(users) {
  const content = document.getElementById('admin-content');
  if (!content) return;
  const isAdminUser = currentUser.role === 'admin';
  const roleOptions = isAdminUser ? '<option value="viewer">Viewer</option><option value="manager">Manager</option><option value="admin">Admin</option>' : '';
  const rows = users.map(u => {
    const badge = u.role === 'admin'
      ? '<span class="role-badge-admin">admin</span>'
      : u.role === 'manager' ? '<span class="role-badge-manager">manager</span>'
      : '<span class="role-badge-viewer">viewer</span>';
    const lastActive = u.last_auth_at ? new Date(u.last_auth_at * 1000).toLocaleDateString() : '—';
    const roleCell = isAdminUser && u.user_id !== currentUser.userId
      ? \`<select style="font-size:12px;padding:2px 4px;border-radius:4px;border:1px solid var(--border-color)"
              onchange="adminAssignRole('\${u.user_id}', this.value, '\${u.display_name}')">
          <option value="viewer" \${u.role==='viewer'?'selected':''}>Viewer</option>
          <option value="manager" \${u.role==='manager'?'selected':''}>Manager</option>
          <option value="admin" \${u.role==='admin'?'selected':''}>Admin</option>
        </select>\`
      : badge;
    return \`<tr>
      <td>\${u.display_name}</td>
      <td style="color:var(--text-muted)">\${u.email || '—'}</td>
      <td>\${roleCell}</td>
      <td style="color:var(--text-muted)">\${lastActive}</td>
    </tr>\`;
  }).join('');
  content.innerHTML = \`
    <table class="admin-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Active</th></tr></thead>
      <tbody>\${rows || '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:16px">No users found</td></tr>'}</tbody>
    </table>
    <p style="font-size:11px;color:var(--text-muted);margin-top:8px">Role changes take effect on next login. Users with no assigned row default to Viewer.</p>
  \`;
}

async function adminAssignRole(userId, role, displayName) {
  try {
    const res = await fetch(\`/api/webapp/admin/users/\${userId}/role\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });
    if (!res.ok) throw new Error(await res.text());
    showToast(\`\${displayName} is now \${role}\`);
  } catch (err) {
    showToast('Failed to assign role: ' + err.message, true);
    await loadAdminTab('users'); // revert UI
  }
}

let shiftTemplateDraft = null;

function renderAdminShiftsTab(templates) {
  const content = document.getElementById('admin-content');
  if (!content) return;
  const templateList = templates.length === 0
    ? '<p style="color:var(--text-muted);font-size:13px">No shift templates yet.</p>'
    : templates.map(t => {
        const rule = JSON.parse(t.recurrence_rule || '{}');
        const days = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const dayStr = (rule.days || []).map(d => days[d] || d).join(', ');
        return \`<div style="border:1px solid var(--border-color);border-radius:8px;padding:12px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>\${t.name}</strong>
            <div style="display:flex;gap:6px">
              <button class="btn-secondary" style="font-size:11px;padding:3px 8px" onclick="adminShowPushModal('\${t.id}','\${t.name}')">Push to Teams</button>
              <button class="btn-secondary" style="font-size:11px;padding:3px 8px" onclick="adminDeleteTemplate('\${t.id}','\${t.name}')">Delete</button>
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
            Days: \${dayStr} • \${rule.start_time || '?'}–\${rule.end_time || '?'} (\${rule.timezone || ''})
            • \${(rule.assignees || []).length} assignee(s) • Team: \${t.team_id.slice(-8)}
          </div>
        </div>\`;
      }).join('');

  content.innerHTML = \`
    \${templateList}
    <button class="sync-btn" style="margin-top:4px" onclick="adminShowCreateTemplate()">+ Create Shift Template</button>
    <div id="admin-template-form" style="display:none;margin-top:16px;border-top:1px solid var(--border-color);padding-top:12px">
      <h4 style="margin:0 0 10px">New Shift Template</h4>
      <label style="font-size:12px;display:block;margin-bottom:6px">Template Name
        <input id="tmpl-name" class="chat-input" style="width:100%;margin-top:2px;font-size:13px;padding:6px 8px" placeholder="e.g. Morning Crew">
      </label>
      <label style="font-size:12px;display:block;margin-bottom:6px">Team ID (from Teams)
        <input id="tmpl-team" class="chat-input" style="width:100%;margin-top:2px;font-size:13px;padding:6px 8px" placeholder="e.g. 19:team-id...">
      </label>
      <label style="font-size:12px;display:block;margin-bottom:6px">Shift Label (shown in Teams)
        <input id="tmpl-label" class="chat-input" style="width:100%;margin-top:2px;font-size:13px;padding:6px 8px" placeholder="e.g. Morning Shift">
      </label>
      <div style="display:flex;gap:12px;margin-bottom:6px">
        <label style="font-size:12px;flex:1">Start Time (HH:MM)
          <input id="tmpl-start" class="chat-input" style="width:100%;margin-top:2px;font-size:13px;padding:6px 8px" value="09:00">
        </label>
        <label style="font-size:12px;flex:1">End Time (HH:MM)
          <input id="tmpl-end" class="chat-input" style="width:100%;margin-top:2px;font-size:13px;padding:6px 8px" value="17:00">
        </label>
      </div>
      <label style="font-size:12px;display:block;margin-bottom:6px">Timezone (IANA)
        <input id="tmpl-tz" class="chat-input" style="width:100%;margin-top:2px;font-size:13px;padding:6px 8px" value="America/New_York">
      </label>
      <label style="font-size:12px;display:block;margin-bottom:6px">Days (check all that apply)</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        \${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d,i)=>\`<label style="font-size:12px;display:flex;align-items:center;gap:3px"><input type="checkbox" value="\${i+1}" class="tmpl-day" \${i<5?'checked':''}> \${d}</label>\`).join('')}
      </div>
      <label style="font-size:12px;display:block;margin-bottom:6px">Assignee AAD IDs (one per line)
        <textarea id="tmpl-assignees" rows="3" style="width:100%;margin-top:2px;font-size:12px;padding:6px 8px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-color);resize:vertical" placeholder="Paste AAD Object IDs, one per line"></textarea>
      </label>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="sync-btn" onclick="adminSaveTemplate()">Save Template</button>
        <button class="btn-secondary" onclick="document.getElementById('admin-template-form').style.display='none'">Cancel</button>
      </div>
    </div>
    <div id="admin-push-modal" style="display:none;margin-top:16px;border-top:1px solid var(--border-color);padding-top:12px"></div>
  \`;
}

function adminShowCreateTemplate() {
  document.getElementById('admin-template-form').style.display = 'block';
}

async function adminSaveTemplate() {
  const name = document.getElementById('tmpl-name').value.trim();
  const team_id = document.getElementById('tmpl-team').value.trim();
  const display_name = document.getElementById('tmpl-label').value.trim();
  const start_time = document.getElementById('tmpl-start').value.trim();
  const end_time = document.getElementById('tmpl-end').value.trim();
  const timezone = document.getElementById('tmpl-tz').value.trim();
  const days = Array.from(document.querySelectorAll('.tmpl-day:checked')).map(cb => Number(cb.value));
  const assignees = document.getElementById('tmpl-assignees').value.split('\\n').map(s => s.trim()).filter(Boolean);

  if (!name || !team_id || days.length === 0 || assignees.length === 0) {
    showToast('Name, Team ID, at least one day, and at least one assignee are required', true);
    return;
  }

  const recurrence_rule = { type: 'weekly', days, start_time, end_time, timezone, assignees };
  try {
    const res = await fetch('/api/webapp/admin/shifts/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, team_id, display_name: display_name || name, recurrence_rule })
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Template created');
    await loadAdminTab('shifts');
  } catch (err) {
    showToast('Failed: ' + err.message, true);
  }
}

async function adminDeleteTemplate(id, name) {
  if (!confirm(\`Delete template "\${name}"? Pushed shifts already in Teams will not be removed.\`)) return;
  const res = await fetch(\`/api/webapp/admin/shifts/templates/\${id}\`, { method: 'DELETE' });
  if (res.ok) { showToast('Template deleted'); await loadAdminTab('shifts'); }
  else showToast('Failed to delete', true);
}

function adminShowPushModal(templateId, templateName) {
  const modal = document.getElementById('admin-push-modal');
  if (!modal) return;
  const today = new Date().toISOString().slice(0, 10);
  const in4weeks = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  modal.style.display = 'block';
  modal.innerHTML = \`
    <h4 style="margin:0 0 10px">Push "\${templateName}" to Teams</h4>
    <div style="display:flex;gap:12px;margin-bottom:10px">
      <label style="font-size:12px;flex:1">From Date
        <input id="push-from" type="date" value="\${today}" style="width:100%;margin-top:2px;padding:6px 8px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-color)">
      </label>
      <label style="font-size:12px;flex:1">To Date (max 92 days)
        <input id="push-to" type="date" value="\${in4weeks}" style="width:100%;margin-top:2px;padding:6px 8px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-color)">
      </label>
    </div>
    <p style="font-size:11px;color:var(--text-muted);margin:0 0 10px">Shifts are written one at a time (~1 sec each). You'll see a confirmation immediately; check push status for results.</p>
    <div style="display:flex;gap:8px">
      <button class="sync-btn" style="background:var(--accent-color);color:#fff;border:none" onclick="adminDoPush('\${templateId}')">Push Shifts</button>
      <button class="btn-secondary" onclick="document.getElementById('admin-push-modal').style.display='none'">Cancel</button>
    </div>
    <div id="push-result" style="margin-top:10px;font-size:12px"></div>
  \`;
}

async function adminDoPush(templateId) {
  const fromDate = document.getElementById('push-from').value;
  const toDate = document.getElementById('push-to').value;
  const result = document.getElementById('push-result');
  if (result) result.innerHTML = '<span style="color:var(--text-muted)">Queuing push…</span>';
  try {
    const res = await fetch(\`/api/webapp/admin/shifts/templates/\${templateId}/push\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDate, toDate })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || JSON.stringify(data));
    if (result) result.innerHTML = \`<span style="color:var(--success-color)">\${data.message}</span>\`;
  } catch (err) {
    if (result) result.innerHTML = \`<span style="color:var(--error-color)">Error: \${err.message}</span>\`;
  }
}

function renderAdminReportsTab() {
  const content = document.getElementById('admin-content');
  if (!content) return;
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  content.innerHTML = \`
    <div style="display:grid;gap:12px">
      \${[
        { type: 'shifts_summary', label: 'Shifts Summary', desc: 'Total shifts and hours per staff member for a date range.' },
        { type: 'time_off_calendar', label: 'Time Off Calendar', desc: 'Approved time-off entries pulled from Teams Shifts.' },
        { type: 'activity_summary', label: 'Activity Summary', desc: 'Arcadia interaction counts and positive rates per user.' }
      ].map(r => \`<div style="border:1px solid var(--border-color);border-radius:8px;padding:12px">
        <strong style="font-size:14px">\${r.label}</strong>
        <p style="font-size:12px;color:var(--text-muted);margin:4px 0 10px">\${r.desc}</p>
        \${r.type !== 'activity_summary' ? \`<div style="display:flex;gap:8px;margin-bottom:8px">
          <input type="date" id="from-\${r.type}" value="\${today}" style="padding:4px 8px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-color);font-size:12px">
          <input type="date" id="to-\${r.type}" value="\${in30}" style="padding:4px 8px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary);color:var(--text-color);font-size:12px">
        </div>\` : ''}
        <button class="sync-btn" style="font-size:12px;padding:4px 10px" onclick="adminRunReport('\${r.type}')">Generate</button>
        <div id="report-result-\${r.type}" style="margin-top:10px;font-size:12px"></div>
      </div>\`).join('')}
    </div>
  \`;
}

async function adminRunReport(type) {
  const resultEl = document.getElementById(\`report-result-\${type}\`);
  if (resultEl) resultEl.innerHTML = '<span style="color:var(--text-muted)">Loading…</span>';
  try {
    let qs = \`type=\${type}\`;
    const fromEl = document.getElementById(\`from-\${type}\`);
    const toEl = document.getElementById(\`to-\${type}\`);
    if (fromEl) qs += \`&startDate=\${fromEl.value}\`;
    if (toEl) qs += \`&endDate=\${toEl.value}\`;
    const res = await fetch(\`/api/webapp/admin/reports/staff?\${qs}\`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    renderReportResult(type, data, resultEl);
  } catch (err) {
    if (resultEl) resultEl.innerHTML = \`<span style="color:var(--error-color)">Error: \${err.message}</span>\`;
  }
}

function renderReportResult(type, data, el) {
  if (!el) return;
  if (type === 'shifts_summary') {
    if (!data.users || data.users.length === 0) { el.innerHTML = '<span style="color:var(--text-muted)">No shift data in this range.</span>'; return; }
    const rows = data.users.map(u => \`<tr><td>\${u.displayName}</td><td style="text-align:center">\${u.totalShifts}</td><td style="text-align:center">\${u.totalHours}h</td></tr>\`).join('');
    el.innerHTML = \`<p style="font-size:11px;color:var(--text-muted)">Total: \${data.totalShifts} shifts / \${data.totalHours}h</p>
      <table class="admin-table"><thead><tr><th>Staff Member</th><th>Shifts</th><th>Hours</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } else if (type === 'time_off_calendar') {
    if (!data.entries || data.entries.length === 0) { el.innerHTML = '<span style="color:var(--text-muted)">No time-off entries in this range.</span>'; return; }
    const rows = data.entries.map(e => \`<tr><td>\${e.displayName}</td><td>\${e.startDateTime?.slice(0,10)}</td><td>\${e.endDateTime?.slice(0,10)}</td></tr>\`).join('');
    el.innerHTML = \`<table class="admin-table"><thead><tr><th>Staff Member</th><th>From</th><th>To</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  } else if (type === 'activity_summary') {
    if (!data.users || data.users.length === 0) { el.innerHTML = '<span style="color:var(--text-muted)">No activity data yet.</span>'; return; }
    const rows = data.users.map(u => \`<tr><td>\${u.displayName}</td><td style="text-align:center">\${u.totalInteractions}</td><td style="text-align:center">\${(u.positiveRate*100).toFixed(0)}%</td><td style="color:var(--text-muted)">\${u.timezone||'—'}</td></tr>\`).join('');
    el.innerHTML = \`<table class="admin-table"><thead><tr><th>Staff Member</th><th>Interactions</th><th>Positive</th><th>Timezone</th></tr></thead><tbody>\${rows}</tbody></table>\`;
  }
}

function renderAdminAuditTab(data) {
  const content = document.getElementById('admin-content');
  if (!content) return;
  const { entries = [], total = 0, limit = 50, offset = 0 } = data;
  if (entries.length === 0) { content.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No audit entries yet.</p>'; return; }
  const rows = entries.map(e => {
    const ts = new Date(e.created_at * 1000).toLocaleString();
    const payload = e.payload ? \`<details><summary style="cursor:pointer;font-size:10px;color:var(--text-muted)">details</summary><pre style="font-size:10px;white-space:pre-wrap;word-break:break-all;background:var(--bg-secondary);padding:4px;border-radius:4px">\${e.payload}</pre></details>\` : '';
    return \`<tr>
      <td style="white-space:nowrap;font-size:11px;color:var(--text-muted)">\${ts}</td>
      <td>\${e.actor_name}</td>
      <td><code style="font-size:11px">\${e.action}</code></td>
      <td style="color:var(--text-muted);font-size:11px">\${e.target_type || ''}:\${e.target_id || ''}</td>
      <td>\${payload}</td>
    </tr>\`;
  }).join('');
  content.innerHTML = \`
    <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px">Showing \${offset+1}–\${offset+entries.length} of \${total}</p>
    <table class="admin-table">
      <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
    \${offset+entries.length < total ? \`<button class="btn-secondary" style="margin-top:8px;font-size:12px" onclick="adminLoadMoreAudit(\${offset+limit})">Load more</button>\` : ''}
  \`;
}

async function adminLoadMoreAudit(offset) {
  try {
    const res = await fetch(\`/api/webapp/admin/audit-log?limit=50&offset=\${offset}\`);
    const data = res.ok ? await res.json() : { entries: [] };
    renderAdminAuditTab({ ...data, offset });
  } catch {}
}

function showToast(msg, isError = false) {
  const existing = document.getElementById('arcadia-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'arcadia-toast';
  toast.style.cssText = \`position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:\${isError ? 'var(--error-color,#e53935)' : 'var(--accent-color)'};
    color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;z-index:99999;
    box-shadow:0 2px 12px rgba(0,0,0,0.25);pointer-events:none\`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ─── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", initApp);
`;
}
