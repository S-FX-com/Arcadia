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

/* ─── Phase 11: Feedback buttons ───────────────────────────────────────────── */
.message-feedback {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity 0.15s;
}
.message:hover .message-feedback,
.message-feedback[data-sent] {
  opacity: 1;
}
.feedback-btn {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  line-height: 1.4;
  color: var(--text-muted);
  transition: border-color 0.1s, color 0.1s;
}
.feedback-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text-primary);
}
.feedback-btn:disabled {
  cursor: default;
  opacity: 0.7;
}

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

/* ─── Sidebar Section Labels ───────────────────────────────────────────────── */
.sidebar-section {
  padding: 8px 8px 4px;
}

.sidebar-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  margin-bottom: 2px;
}

.sidebar-section-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  letter-spacing: 0.8px;
  text-transform: uppercase;
}

.sidebar-section-add {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  line-height: 1;
  padding: 0 4px;
  transition: color var(--transition);
}

.sidebar-section-add:hover { color: var(--accent); }

/* ─── Client Items ─────────────────────────────────────────────────────────── */
.client-item {
  display: flex;
  align-items: center;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition);
  margin-bottom: 2px;
  gap: 8px;
}

.client-item:hover { background: var(--bg-card-hover); }
.client-item.active { background: var(--bg-tertiary); border: 1px solid var(--border-active); }

.client-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.client-status-dot.pending { background: var(--text-muted); }
.client-status-dot.indexing { background: var(--accent); animation: pulse 1.4s infinite; }
.client-status-dot.ready { background: var(--success); }
.client-status-dot.error { background: var(--error); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.client-item-info { flex: 1; min-width: 0; }

.client-item-name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.client-item-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 1px;
}

.client-notification-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* ─── Client Context Badge ─────────────────────────────────────────────────── */
.client-context-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  background: var(--accent-glow);
  border: 1px solid var(--border-active);
  color: var(--accent);
  margin-bottom: 8px;
}

/* ─── Input Tabs ───────────────────────────────────────────────────────────── */
.input-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.input-tab {
  padding: 5px 14px;
  border-radius: 20px;
  border: 1px solid var(--border-color);
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--transition);
}

.input-tab:hover {
  border-color: var(--border-active);
  color: var(--text-primary);
}

.input-tab.active {
  background: var(--accent-glow);
  border-color: var(--accent);
  color: var(--accent);
}

/* ─── Image Model Selector ─────────────────────────────────────────────────── */
.image-model-select {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 12px;
  padding: 4px 8px;
  margin-bottom: 8px;
  cursor: pointer;
  outline: none;
}

.image-model-select:focus {
  border-color: var(--border-active);
}

/* ─── Sync Button ──────────────────────────────────────────────────────────── */
.sync-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  transition: all var(--transition);
  white-space: nowrap;
}

.sync-btn:hover { color: var(--accent); background: var(--accent-glow); }
.sync-btn.syncing { color: var(--accent); }
.sync-btn.synced { color: var(--success); }
.sync-btn.error { color: var(--error); }

/* ─── Generated Image ──────────────────────────────────────────────────────── */
.generated-image-wrap {
  position: relative;
  display: inline-block;
  margin-top: 10px;
}

.generated-image-wrap img {
  max-width: 100%;
  border-radius: var(--radius-md);
  display: block;
}

.generated-image-wrap .img-download {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(0,0,0,0.6);
  border: none;
  border-radius: var(--radius-sm);
  color: #fff;
  font-size: 12px;
  padding: 4px 8px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition);
  text-decoration: none;
}

.generated-image-wrap:hover .img-download { opacity: 1; }

/* ─── Client Wizard Modal ──────────────────────────────────────────────────── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  overflow-y: auto;
}

.modal h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
}

.modal-field {
  margin-bottom: 14px;
}

.modal-field label {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 5px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.modal-field input, .modal-field textarea {
  width: 100%;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
  padding: 8px 10px;
  outline: none;
  font-family: var(--font-sans);
  transition: border-color var(--transition);
}

.modal-field input:focus, .modal-field textarea:focus {
  border-color: var(--border-active);
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 20px;
}

.btn-primary {
  padding: 8px 20px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition);
}

.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-secondary {
  padding: 8px 16px;
  background: none;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
  transition: all var(--transition);
}

.btn-secondary:hover { border-color: var(--border-active); color: var(--text-primary); }

.source-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }

.source-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition);
  user-select: none;
}

.source-item:hover { border-color: var(--border-active); background: var(--bg-tertiary); }
.source-item.selected { background: var(--accent-glow); border-color: var(--accent); }

.source-item-icon { font-size: 14px; }
.source-item-name { font-size: 13px; color: var(--text-primary); flex: 1; }
.source-item-type { font-size: 11px; color: var(--text-muted); }

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
