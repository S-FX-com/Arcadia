// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Styles (Phase 7)
//
// S-FX branded dark theme. Exported as a string constant for inline serving.
// ─────────────────────────────────────────────────────────────────────────────

export const APP_CSS = `
/* ─── Reset & Base ─────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg-primary: #060a14;
  --bg-secondary: #0c1220;
  --bg-tertiary: #121a2e;
  --bg-card: rgba(16, 24, 48, 0.7);
  --bg-card-hover: rgba(20, 30, 56, 0.8);
  --border-color: rgba(255, 255, 255, 0.06);
  --border-active: rgba(0, 180, 216, 0.3);
  --text-primary: #e8eaf0;
  --text-secondary: #8b92a8;
  --text-muted: #5a6178;
  --accent: #00b4d8;
  --accent-hover: #48cae4;
  --accent-glow: rgba(0, 180, 216, 0.15);
  --success: #10b981;
  --warning: #f59e0b;
  --error: #ef4444;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --shadow-glow: 0 0 20px rgba(0, 180, 216, 0.08);
  --transition: 150ms ease;
}

html, body {
  height: 100%;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg-primary);
  -webkit-font-smoothing: antialiased;
}

/* ─── Grid Background ──────────────────────────────────────────────────────── */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    linear-gradient(180deg, transparent 0%, var(--bg-primary) 100%),
    radial-gradient(ellipse at 20% 0%, rgba(0, 180, 216, 0.04) 0%, transparent 60%);
  pointer-events: none;
  z-index: -1;
}

/* ─── Layout ───────────────────────────────────────────────────────────────── */
#app {
  height: 100vh;
  display: flex;
}

/* ─── Login Screen ─────────────────────────────────────────────────────────── */
.login-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  width: 100%;
  gap: 32px;
}

.login-logo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.login-logo h1 {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.5px;
  color: var(--text-primary);
}

.login-logo h1 span {
  color: var(--accent);
}

.login-logo p {
  color: var(--text-secondary);
  font-size: 15px;
}

.login-badge {
  display: inline-block;
  padding: 4px 12px;
  background: var(--accent-glow);
  border: 1px solid var(--border-active);
  border-radius: 20px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.login-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 28px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition), transform var(--transition);
}

.login-btn:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.login-btn svg {
  width: 20px;
  height: 20px;
}

.login-error {
  color: var(--error);
  font-size: 13px;
  max-width: 400px;
  text-align: center;
}

/* ─── Sidebar ──────────────────────────────────────────────────────────────── */
.sidebar {
  width: 280px;
  min-width: 280px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--border-color);
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.sidebar-brand h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.sidebar-brand h2 span {
  color: var(--accent);
}

.new-chat-btn {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all var(--transition);
  text-align: left;
}

.new-chat-btn:hover {
  background: var(--bg-card-hover);
  border-color: var(--border-active);
  color: var(--text-primary);
}

.sidebar-conversations {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.conv-item {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition);
  margin-bottom: 2px;
}

.conv-item:hover {
  background: var(--bg-card-hover);
}

.conv-item.active {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-active);
}

.conv-item-title {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-item-date {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.conv-item-delete {
  display: none;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}

.conv-item:hover .conv-item-delete {
  display: inline-block;
}

.conv-item-delete:hover {
  color: var(--error);
  background: rgba(239, 68, 68, 0.1);
}

.conv-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent-glow);
  border: 1px solid var(--border-active);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}

.user-name {
  font-size: 12px;
  color: var(--text-secondary);
}

.logout-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  transition: all var(--transition);
}

.logout-btn:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

/* ─── Chat Area ────────────────────────────────────────────────────────────── */
.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px 0;
  scroll-behavior: smooth;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 16px;
  color: var(--text-secondary);
}

.chat-empty h3 {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-primary);
}

.chat-empty p {
  max-width: 400px;
  text-align: center;
  font-size: 14px;
  line-height: 1.7;
}

/* ─── Messages ─────────────────────────────────────────────────────────────── */
.message {
  padding: 4px 0;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
  padding-left: 24px;
  padding-right: 24px;
}

.message-content {
  padding: 12px 16px;
  border-radius: var(--radius-md);
  font-size: 14px;
  line-height: 1.7;
}

.message.user .message-content {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
}

.message.assistant .message-content {
  background: transparent;
}

.message-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.message.assistant .message-label {
  color: var(--accent);
}

/* Markdown styling inside messages */
.message-content p { margin: 0 0 8px; }
.message-content p:last-child { margin-bottom: 0; }
.message-content strong { color: var(--text-primary); font-weight: 600; }
.message-content em { color: var(--text-secondary); }
.message-content ul, .message-content ol { margin: 4px 0 8px 20px; }
.message-content li { margin: 2px 0; }
.message-content code {
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border-color);
}
.message-content pre {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 12px;
  overflow-x: auto;
  margin: 8px 0;
}
.message-content pre code {
  background: none;
  border: none;
  padding: 0;
}
.message-content h1, .message-content h2, .message-content h3 {
  color: var(--text-primary);
  margin: 16px 0 8px;
}
.message-content h1 { font-size: 18px; }
.message-content h2 { font-size: 16px; }
.message-content h3 { font-size: 14px; }

/* ─── Typing indicator ─────────────────────────────────────────────────────── */
.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 4px 0;
}

.typing-dot {
  width: 6px;
  height: 6px;
  background: var(--accent);
  border-radius: 50%;
  animation: typing 1.2s infinite ease-in-out;
}

.typing-dot:nth-child(2) { animation-delay: 0.15s; }
.typing-dot:nth-child(3) { animation-delay: 0.3s; }

@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
  30% { opacity: 1; transform: scale(1); }
}

/* ─── Input Area ───────────────────────────────────────────────────────────── */
.chat-input-area {
  padding: 0 24px 24px;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
}

.context-chips {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.context-chip {
  padding: 4px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--transition);
  user-select: none;
}

.context-chip:hover {
  border-color: var(--border-active);
  color: var(--text-primary);
}

.context-chip.active {
  background: var(--accent-glow);
  border-color: var(--accent);
  color: var(--accent);
}

.input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 8px 12px;
  transition: border-color var(--transition), box-shadow var(--transition);
}

.input-wrapper:focus-within {
  border-color: var(--border-active);
  box-shadow: var(--shadow-glow);
}

.input-wrapper textarea {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  max-height: 150px;
  min-height: 24px;
}

.input-wrapper textarea::placeholder {
  color: var(--text-muted);
}

.send-btn {
  width: 32px;
  height: 32px;
  background: var(--accent);
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--transition), opacity var(--transition);
  flex-shrink: 0;
}

.send-btn:hover { background: var(--accent-hover); }
.send-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.send-btn svg { width: 16px; height: 16px; }

/* ─── Scrollbar ────────────────────────────────────────────────────────────── */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.1); }

/* ─── Responsive ───────────────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .sidebar { width: 100%; min-width: 100%; position: absolute; z-index: 10; transform: translateX(-100%); transition: transform 200ms ease; }
  .sidebar.open { transform: translateX(0); }
  .menu-toggle { display: flex !important; }
}

.menu-toggle {
  display: none;
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 20;
  width: 36px;
  height: 36px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
`;
