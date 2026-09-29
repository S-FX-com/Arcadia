// The Leadership directory chart: drag to pan, zoom, collapse, and one Apply.
// Apply posts every pending manager on the tree and redraws it. Add on an
// Unplaced name posts that one manager through the same overlay. Neither
// writes to Entra. A drag that starts on a control leaves that control alone.

import { render } from "preact-render-to-string";
import type { ChartEdge, ChartNode, ChartPerson, DirectoryTree, EdgeSource } from "../lib/directory-chart";

export interface OrgChartModel {
  tree: DirectoryTree;
  people: ChartPerson[];
  edges: Map<string, ChartEdge>;
  baselines: Map<string, string>;
}

const ORG_CHART_SCRIPT = `
(function () {
  var stage = document.querySelector("[data-orgstage]");
  if (!stage || stage.getAttribute("data-org-ready") === "1") return;
  stage.setAttribute("data-org-ready", "1");
  var scale = 1;
  var panX = 0;
  var panY = 0;
  var collapsed = {};
  var drag = null;
  var suppressClick = false;
  var MIN = 0.25;
  var MAX = 2;

  function canvas() { return stage.querySelector("[data-canvas]"); }
  function viewport() { return stage.querySelector("[data-viewport]"); }
  function label() { return stage.querySelector("[data-zoom-label]"); }
  function applyBtn() { return stage.querySelector("[data-apply]"); }
  function note() { return stage.querySelector("[data-chart-note]"); }

  function showNote(text, tone) {
    var n = note();
    if (!n) return;
    n.hidden = !text;
    n.textContent = text || "";
    n.className = tone === "warn" ? "banner warn" : "banner ok";
  }

  function paintZoom() {
    var c = canvas();
    if (c) {
      c.style.zoom = String(scale);
      c.style.translate = panX + "px " + panY + "px";
    }
    var lab = label();
    if (lab) lab.textContent = Math.round(scale * 100) + "%";
    var v = viewport();
    if (v) {
      v.setAttribute("data-pan-x", String(Math.round(panX)));
      v.setAttribute("data-pan-y", String(Math.round(panY)));
    }
  }

  function fit() {
    panX = 0;
    panY = 0;
    var c = canvas();
    var v = viewport();
    if (!c || !v) { scale = 1; paintZoom(); return; }
    c.style.zoom = "1";
    c.style.translate = "0px 0px";
    var natural = c.scrollWidth;
    var available = v.clientWidth;
    var next = natural > 0 && available > 0 ? available / natural : 1;
    if (next > 1) next = 1;
    if (next < MIN) next = MIN;
    scale = Math.round(next * 100) / 100;
    paintZoom();
  }

  function setCollapsed() {
    var nodes = stage.querySelectorAll("[data-branch]");
    for (var i = 0; i < nodes.length; i++) {
      var li = nodes[i];
      var id = li.getAttribute("data-branch");
      var on = !!collapsed[id];
      li.classList.toggle("is-collapsed", on);
      var btn = li.querySelector(":scope > .orgnode [data-toggle]");
      if (!btn) continue;
      var n = li.getAttribute("data-report-count") || "0";
      btn.setAttribute("aria-expanded", on ? "false" : "true");
      btn.textContent = on ? "Expand · " + n + " hidden" : "Collapse";
    }
  }

  function pendingCards() {
    var cards = stage.querySelectorAll("[data-person]:not([data-unplaced-row])");
    var pending = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var sel = card.querySelector("[data-manager]");
      if (!sel) continue;
      var current = card.getAttribute("data-current") || "";
      var isPending = sel.value !== current;
      card.classList.toggle("is-pending", isPending);
      var flag = card.querySelector("[data-pending-flag]");
      if (flag) flag.hidden = !isPending;
      if (isPending) pending.push(card);
    }
    var btn = applyBtn();
    if (btn) btn.disabled = pending.length === 0;
    return pending;
  }

  function isControl(node) {
    return !!(node && node.closest && node.closest("button, a, select, input, textarea, label"));
  }

  stage.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0) return;
    var v = viewport();
    if (!v || !v.contains(ev.target)) return;
    if (isControl(ev.target)) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, panX: panX, panY: panY, moved: false };
    v.classList.add("is-panning");
    if (v.setPointerCapture) v.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  stage.addEventListener("pointermove", function (ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    var dx = ev.clientX - drag.x;
    var dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    panX = drag.panX + dx;
    panY = drag.panY + dy;
    paintZoom();
    ev.preventDefault();
  });

  function endDrag(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    if (drag.moved) suppressClick = true;
    drag = null;
    var v = viewport();
    if (v) v.classList.remove("is-panning");
  }
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  stage.addEventListener("click", function (ev) {
    if (suppressClick) {
      suppressClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    var t = ev.target;
    if (!t || !t.closest) return;
    var zoom = t.closest("[data-zoom]");
    if (zoom && stage.contains(zoom)) {
      var kind = zoom.getAttribute("data-zoom");
      if (kind === "in") scale = Math.min(MAX, Math.round((scale + 0.1) * 100) / 100);
      else if (kind === "out") scale = Math.max(MIN, Math.round((scale - 0.1) * 100) / 100);
      else if (kind === "fit") { fit(); return; }
      paintZoom();
      return;
    }
    var toggle = t.closest("[data-toggle]");
    if (toggle && stage.contains(toggle)) {
      var li = toggle.closest("[data-branch]");
      if (!li) return;
      var id = li.getAttribute("data-branch");
      if (collapsed[id]) delete collapsed[id];
      else collapsed[id] = true;
      setCollapsed();
      return;
    }
    var add = t.closest("[data-add]");
    if (add && stage.contains(add)) {
      ev.preventDefault();
      var row = add.closest("[data-unplaced-row]");
      if (!row) return;
      var sel = row.querySelector("[data-manager]");
      var manager = sel ? sel.value : "";
      if (!manager) {
        showNote("Pick a manager, then Add.", "warn");
        return;
      }
      add.disabled = true;
      postChanges([{
        aadId: row.getAttribute("data-person"),
        baseline: row.getAttribute("data-baseline") || "",
        managerAadId: manager
      }]);
      return;
    }
    if (t.closest("[data-apply]")) {
      ev.preventDefault();
      applyChanges();
    }
  });

  stage.addEventListener("change", function (ev) {
    var t = ev.target;
    if (t && t.matches && t.matches("[data-manager]")) pendingCards();
  });

  function enableAdds() {
    var adds = stage.querySelectorAll("[data-add]");
    for (var i = 0; i < adds.length; i++) adds[i].disabled = false;
  }

  function postChanges(changes) {
    if (!changes.length) return;
    fetch("/agency/leadership/place", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ changes: changes })
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; }, function () { return { ok: false, data: null }; });
    }).then(function (result) {
      var data = result.data;
      if (!result.ok || !data || typeof data.chartHtml !== "string") {
        showNote(data && data.notice ? data.notice : "Apply did not save. Try again.", "warn");
        pendingCards();
        enableAdds();
        return;
      }
      var root = stage.querySelector("[data-chart-root]");
      if (root) root.innerHTML = data.chartHtml;
      setCollapsed();
      paintZoom();
      pendingCards();
      enableAdds();
      stage.setAttribute("data-applies", String(Number(stage.getAttribute("data-applies") || "0") + 1));
      showNote(data.notice || "", data.tone === "warn" ? "warn" : "ok");
      if (typeof data.unplaced === "number") {
        var stat = document.querySelector("[data-unplaced-stat] .v");
        if (stat) stat.textContent = String(data.unplaced);
      }
    }).catch(function () {
      showNote("Apply did not reach Arcadia. Try again.", "warn");
      pendingCards();
      enableAdds();
    });
  }

  function applyChanges() {
    var cards = pendingCards();
    if (!cards.length) return;
    var btn = applyBtn();
    if (btn) btn.disabled = true;
    var changes = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var sel = card.querySelector("[data-manager]");
      changes.push({
        aadId: card.getAttribute("data-person"),
        baseline: card.getAttribute("data-baseline") || "",
        managerAadId: sel ? sel.value : ""
      });
    }
    postChanges(changes);
  }

  pendingCards();
  paintZoom();
})();
`;

function edgeWord(source: EdgeSource): string {
  if (source === "overlay") return "Arcadia";
  if (source === "graph") return "Microsoft 365";
  if (source === "lead") return "staff record";
  return "";
}

function selectedManager(source: EdgeSource, managerId: string | null): string {
  if (managerId) return managerId;
  if (source === "overlay" || source === "none") return "__unplaced__";
  return "__clear__";
}

function ChartCard(props: {
  person: ChartPerson;
  source: EdgeSource;
  managerId: string | null;
  loop: boolean;
  chart: OrgChartModel;
  reports: number;
}) {
  const { person, chart } = props;
  const manager = props.managerId ? chart.people.find((row) => row.id === props.managerId) : undefined;
  const via = edgeWord(props.source);
  const line = props.loop
    ? "Reporting loop. The line was cut so the chart can draw."
    : manager
      ? `Reports to ${manager.name}${via ? ` · ${via}` : ""}`
      : "No reporting line";
  const picked = selectedManager(props.source, props.managerId);
  return (
    <div
      class={props.loop ? "orgnode loop" : "orgnode"}
      data-person={person.id}
      data-name={person.name}
      data-baseline={chart.baselines.get(person.id) ?? "none:"}
      data-current={picked}
    >
      {props.reports > 0 ? (
        <button type="button" class="orgtoggle" data-toggle aria-expanded="true">
          Collapse
        </button>
      ) : null}
      <div class="avatar" aria-hidden="true">
        {person.initials}
      </div>
      <strong>{person.name}</strong>
      <small class="muted orgline">{person.title ?? "No title"}</small>
      <small class="muted orgline">{person.department ?? "No department"}</small>
      <small class="muted orgline">{line}</small>
      <span class="orgpending" data-pending-flag hidden>
        Pending
      </span>
      <label class="orglabel">
        Manager
        <select name="managerAadId" data-manager>
          <option value="__clear__" selected={picked === "__clear__"}>
            Microsoft 365 line
          </option>
          <option value="__unplaced__" selected={picked === "__unplaced__"}>
            Unplaced
          </option>
          {chart.people
            .filter((row) => row.id !== person.id)
            .map((row) => (
              <option value={row.id} selected={picked === row.id}>
                {row.name}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}

function ChartBranch(props: { node: ChartNode; chart: OrgChartModel }) {
  const { node, chart } = props;
  const edge = chart.edges.get(node.person.id);
  return (
    <li data-branch={node.person.id} data-report-count={node.reports.length}>
      <ChartCard
        person={node.person}
        source={edge?.source ?? node.source}
        managerId={edge?.managerId ?? null}
        loop={node.loop}
        chart={chart}
        reports={node.reports.length}
      />
      {node.reports.length ? (
        <ul data-reports>
          {node.reports.map((child) => (
            <ChartBranch node={child} chart={chart} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The tree and Unplaced. Apply replaces this markup and keeps zoom and collapse. */
export function ChartBody(props: { chart: OrgChartModel }) {
  const { chart } = props;
  const { tree } = chart;
  if (chart.people.length === 0) {
    return <p class="empty">No active member users in the directory. Sync from Microsoft 365 to fill this chart.</p>;
  }
  return (
    <>
      {tree.roots.length ? (
        <div class="orgviewport" data-viewport data-pan-x="0" data-pan-y="0">
          <div class="orgcanvas" data-canvas>
            <ul class="orgchart">
              {tree.roots.map((root) => (
                <ChartBranch node={root} chart={chart} />
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p class="empty">No reporting line connects anyone yet. Everyone without a line is in Unplaced.</p>
      )}
      <h2 id="unplaced">Unplaced ({tree.unplaced.length})</h2>
      {tree.unplaced.length === 0 ? (
        <p class="empty">Everyone on this chart has a reporting line.</p>
      ) : (
        <ul class="unplaced-list">
          {tree.unplaced.map((row) => (
            <li
              class="unplaced-row"
              data-unplaced-row
              data-person={row.person.id}
              data-baseline={chart.baselines.get(row.person.id) ?? "none:"}
            >
              <span class="unplaced-name">{row.person.name}</span>
              <select data-manager aria-label={`Manager for ${row.person.name}`}>
                <option value="">Manager</option>
                {chart.people
                  .filter((person) => person.id !== row.person.id)
                  .map((person) => (
                    <option value={person.id}>{person.name}</option>
                  ))}
              </select>
              <button type="button" data-add>
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function chartRootHtml(chart: OrgChartModel): string {
  return render(<ChartBody chart={chart} />);
}

export function directoryChartHtml(chart: OrgChartModel): string {
  return render(<DirectoryChartView chart={chart} />);
}

export function DirectoryChartView(props: { chart: OrgChartModel }) {
  const { chart } = props;
  if (chart.people.length === 0) return <ChartBody chart={chart} />;
  return (
    <div class="orgstage" data-orgstage>
      <div class="orgtools">
        <button type="button" data-zoom="out">
          Zoom out
        </button>
        <span class="orgzoom" data-zoom-label>
          100%
        </span>
        <button type="button" data-zoom="in">
          Zoom in
        </button>
        <button type="button" data-zoom="fit">
          Fit
        </button>
        <button type="button" class="primary orgapply" data-apply disabled>
          Apply
        </button>
      </div>
      <p class="banner" data-chart-note hidden role="status" />
      <div data-chart-root>
        <ChartBody chart={chart} />
      </div>
      <script dangerouslySetInnerHTML={{ __html: ORG_CHART_SCRIPT }} />
    </div>
  );
}
