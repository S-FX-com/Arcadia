// Inline live-chat script. Server-rendered page, no bundle — this is the
// one client script Ask Arcadia is allowed. Progressive: no-JS still POSTs.

export const CHAT_LIVE_SCRIPT = `(function () {
  var form = document.querySelector("#ask-form");
  if (!form || !window.fetch) return;
  var input = form.querySelector('input[name="question"]');
  var sendBtn = form.querySelector('button[type="submit"]');
  var thread = document.getElementById("thread");
  if (!input || !thread) return;

  var lastSeq = Number(thread.getAttribute("data-last-seq") || "0");
  var inflight = false;

  function esc(s) {
    return String(s)
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/"/g, """);
  }

  function stamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  function appendTurn(html) {
    var empty = thread.querySelector(".empty");
    if (empty) empty.remove();
    thread.insertAdjacentHTML("beforeend", html);
    var latest = thread.querySelector(".turn:last-child");
    if (latest) latest.scrollIntoView({ block: "end", behavior: "smooth" });
    return latest;
  }

  function userHtml(text) {
    return (
      '<div class="turn user"><span class="who">You · ' +
      esc(stamp()) +
      '</span><div class="bubble">' +
      esc(text) +
      "</div></div>"
    );
  }

  function pendingHtml() {
    return (
      '<div class="turn arcadia pending" id="pending-turn">' +
      '<span class="who">Arcadia · writing</span>' +
      '<div class="bubble"><span class="dots"><i></i><i></i><i></i></span></div></div>'
    );
  }

  function arcadiaHtml(turn) {
    var mode = turn.mode || "";
    var meta;
    if (mode === "inferred") {
      meta = "Inferred — adjacent doctrine as gravity, not a citation.";
      if (turn.gap_id) {
        meta +=
          ' Logged as gap <code>' +
          esc(turn.gap_id) +
          '</code> · <a href="/chat/gaps">open gaps</a>';
      }
    } else if (turn.citations && turn.citations.length) {
      meta = "Cited · " + turn.citations.map(esc).join(" · ");
    } else {
      meta = "Cited — no entry ids recorded.";
    }
    var cls = "turn arcadia" + (mode === "inferred" ? " inferred" : "");
    return (
      '<div class="' +
      cls +
      '" id="latest"><span class="who">Arcadia · ' +
      esc(turn.created_at || stamp()) +
      '</span><div class="bubble">' +
      esc(turn.content) +
      "</div><small class=\\"muted\\">" +
      meta +
      "</small></div>"
    );
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  async function waitForReply() {
    var started = Date.now();
    while (Date.now() - started < 120000) {
      var res = await fetch("/chat/updates?after=" + encodeURIComponent(String(lastSeq)), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("poll failed");
      var data = await res.json();
      var turns = data.turns || [];
      if (turns.length) {
        var pending = document.getElementById("pending-turn");
        if (pending) pending.remove();
        for (var i = 0; i < turns.length; i++) {
          var t = turns[i];
          if (typeof t.seq === "number" && t.seq > lastSeq) lastSeq = t.seq;
          if (t.role === "arcadia") appendTurn(arcadiaHtml(t));
        }
        thread.setAttribute("data-last-seq", String(lastSeq));
        return;
      }
      await sleep(450);
    }
    throw new Error("timeout");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = String(input.value || "").trim();
    if (!q || inflight) return;
    inflight = true;
    input.value = "";
    if (sendBtn) sendBtn.disabled = true;
    appendTurn(userHtml(q));
    appendTurn(pendingHtml());

    fetch("/chat/send", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question: q }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("send failed");
        return res.json();
      })
      .then(function (data) {
        if (typeof data.seq === "number") lastSeq = data.seq;
        return waitForReply();
      })
      .catch(function () {
        var pending = document.getElementById("pending-turn");
        if (pending) {
          pending.classList.remove("pending");
          var bubble = pending.querySelector(".bubble");
          if (bubble) bubble.textContent = "I could not complete that answer. Try again.";
        }
      })
      .then(function () {
        inflight = false;
        if (sendBtn) sendBtn.disabled = false;
        input.focus();
      });
  });
})();
`;
