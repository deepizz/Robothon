/**
 * simulation.js
 * IntelliFleet Frontend  —  Canvas Renderer + API Polling + UI Controls
 *
 * Architecture
 * ────────────
 *  gridLogic   – canvas sizing, cell drawing, heatmap
 *  robotLogic  – drawing robots, paths, fleet-status sidebar
 *  uiLogic     – topbar controls, banners, log, chart
 *
 * Key global variables
 * ────────────────────
 *  robots[]        – global array that mirrors the server's robot list
 *  globalSpeed     – the one speed value shared by ALL robots
 *  currentTaskMode – 'warehouse' | 'random' | 'target'
 */

"use strict";

/* ════════════════════════════════════════════════════════════════════════════
   GRID LOGIC
   ════════════════════════════════════════════════════════════════════════════ */

const GRID_W = 10;
const GRID_H = 10;

// Cell type → background colour map
const CELL_COLORS = {
  0: "#141b24",   // EMPTY
  1: "#1a2535",   // OBSTACLE
  2: "#14532d",   // PICKUP
  3: "#1e3a5f",   // DROPOFF
  4: "#451a03",   // CHARGER
  5: "#3b0764",   // TARGET  (purple-dark)
};

// Accent glow colour for special cells
const CELL_GLOW = {
  2: "#22c55e",   // PICKUP  – green
  3: "#3b82f6",   // DROPOFF – blue
  4: "#f59e0b",   // CHARGER – amber
  5: "#c026d3",   // TARGET  – magenta
};

const canvas = document.getElementById("sim-canvas");
const ctx = canvas.getContext("2d");

/**
 * Resize the canvas to fill its container while keeping cells square.
 * Stores the computed cell size in canvas._cell for use by the renderer.
 */
function resizeCanvas() {
  const area = document.getElementById("sim-area");
  const W = area.clientWidth;
  const H = area.clientHeight;
  const cs = Math.floor(Math.min(W / GRID_W, H / GRID_H) * 0.96);
  canvas.width = cs * GRID_W;
  canvas.height = cs * GRID_H;
  canvas._cell = cs;
  if (lastState) render(lastState);
}

window.addEventListener("resize", resizeCanvas);

/**
 * Interpolate a cold→hot colour for the heatmap view.
 * t = 0..1 → dark-blue → cyan → green → yellow → red
 */
function heatColor(t) {
  const stops = [
    [0.00, [13, 17, 36]],
    [0.20, [6, 72, 135]],
    [0.45, [6, 182, 212]],
    [0.70, [234, 179, 8]],
    [1.00, [239, 68, 68]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      const r = Math.round(c0[0] + f * (c1[0] - c0[0]));
      const g = Math.round(c0[1] + f * (c1[1] - c0[1]));
      const b = Math.round(c0[2] + f * (c1[2] - c0[2]));
      return `rgb(${r},${g},${b})`;
    }
  }
  return "#ef4444";
}

/**
 * Draw all grid cells (simulation or heatmap view).
 */
function drawGrid(state) {
  const cs = canvas._cell;
  const grid = state.grid;
  const hm = state.heatmap;
  let hmMax = 1;
  for (let r = 0; r < GRID_H; r++)
    for (let c = 0; c < GRID_W; c++)
      if (hm && hm[r] && hm[r][c] > hmMax) hmMax = hm[r][c];

  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const x = c * cs;
      const y = r * cs;
      const ct = grid[r][c];

      if (viewMode === "heat") {
        // Heatmap — obstacles stay dark, everything else is heat-coloured
        ctx.fillStyle = ct === 1 ? "#0d1117" : heatColor(hm[r][c] / hmMax);
        ctx.fillRect(x, y, cs, cs);
      } else {
        // Simulation view
        ctx.fillStyle = CELL_COLORS[ct] ?? CELL_COLORS[0];
        ctx.fillRect(x, y, cs, cs);

        // Coloured glow + icon for special cells
        if (CELL_GLOW[ct]) {
          ctx.globalAlpha = ct === 5 ? 0.45 : 0.35;  // TARGET a bit brighter
          ctx.fillStyle = CELL_GLOW[ct];
          ctx.fillRect(x + 2, y + 2, cs - 4, cs - 4);
          ctx.globalAlpha = 1;

          ctx.fillStyle = CELL_GLOW[ct];
          ctx.font = `bold ${Math.floor(cs * 0.42)}px 'Barlow Condensed', sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const icons = { 2: "P", 3: "D", 4: "⚡", 5: "🎯" };
          ctx.fillText(icons[ct] || "", x + cs / 2, y + cs / 2);

          // Pulsing ring for Target cell
          if (ct === 5) {
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
            ctx.globalAlpha = pulse * 0.55;
            ctx.strokeStyle = CELL_GLOW[5];
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 2, y + 2, cs - 4, cs - 4);
            ctx.globalAlpha = 1;
          }
        }

        // Subtle grid line
        ctx.strokeStyle = "rgba(20,27,36,0.8)";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x + 0.25, y + 0.25, cs - 0.5, cs - 0.5);
      }
    }
  }
}


/* ════════════════════════════════════════════════════════════════════════════
   ROBOT LOGIC
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Draw robots' planned paths as faint dashed lines.
 */
function drawPaths(state) {
  const cs = canvas._cell;
  for (const robot of state.robots) {
    if (!robot.path || robot.path.length < 2) continue;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = robot.color;
    ctx.lineWidth = cs * 0.10;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([cs * 0.15, cs * 0.25]);
    ctx.beginPath();
    const [r0, c0] = robot.pos;
    ctx.moveTo(c0 * cs + cs / 2, r0 * cs + cs / 2);
    for (const [pr, pc] of robot.path) {
      ctx.lineTo(pc * cs + cs / 2, pr * cs + cs / 2);
    }
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Draw every robot: glow → circle → battery ring → ID label → state dot.
 */
function drawRobots(state) {
  const cs = canvas._cell;
  for (const robot of state.robots) {
    const [r, c] = robot.pos;
    const cx_ = c * cs + cs / 2;
    const cy_ = r * cs + cs / 2;
    const rad = cs * 0.34;

    // Glow halo
    ctx.save();
    const glowR = cs * 0.52;
    const grad = ctx.createRadialGradient(cx_, cy_, 0, cx_, cy_, glowR);
    grad.addColorStop(0, robot.color + "50");
    grad.addColorStop(1, robot.color + "00");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx_, cy_, glowR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Robot body circle
    ctx.beginPath();
    ctx.arc(cx_, cy_, rad, 0, Math.PI * 2);
    ctx.fillStyle = robot.color;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Battery arc (only meaningful in warehouse mode; shows full in other modes)
    const batt = robot.battery ?? 100;
    const battFrac = batt / 100;
    const battColor = battFrac > 0.5 ? "#22c55e" : battFrac > 0.22 ? "#f59e0b" : "#ef4444";
    ctx.beginPath();
    ctx.arc(cx_, cy_, rad + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * battFrac);
    ctx.strokeStyle = battColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // ID label
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.max(8, Math.floor(cs * 0.30))}px 'Barlow Condensed', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(robot.id, cx_, cy_);

    // State dot (top-right corner of circle)
    const dotX = cx_ + rad * 0.7;
    const dotY = cy_ - rad * 0.7;
    const dotColors = { idle: "#7a9bb5", moving: "#06b6d4", charging: "#f59e0b", waiting: "#ef4444", arrived: "#c026d3" };
    ctx.beginPath();
    ctx.arc(dotX, dotY, cs * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = dotColors[robot.state] ?? "#7a9bb5";
    ctx.fill();
  }
}

/**
 * Master render function — called every time we receive a new state snapshot.
 */
function render(state) {
  drawGrid(state);
  if (viewMode === "heat") return;   // heatmap mode: no robots overlay
  drawPaths(state);
  drawRobots(state);
}

/**
 * Update the Fleet Status sidebar with current robot data.
 */
function updateRobotList(robots) {
  const list = document.getElementById("robot-list");
  list.innerHTML = "";

  for (const r of robots) {
    const bpct = r.battery ?? 100;
    const bcolor = bpct > 50 ? "#22c55e" : bpct > 22 ? "#f59e0b" : "#ef4444";
    const row = document.createElement("div");
    row.className = "robot-row";
    row.innerHTML = `
      <div class="robot-dot" style="background:${r.color};color:${r.color}"></div>
      <div class="robot-info">
        <div class="robot-name">UNIT-${r.id}</div>
        <div class="robot-meta">DIST:${r.dist} &nbsp;|&nbsp; TASKS:${r.tasks_done} &nbsp;|&nbsp; EFF:${r.efficiency}%</div>
        <div class="batt-bar">
          <div class="batt-fill" style="width:${bpct}%;background:${bcolor}"></div>
        </div>
      </div>
      <div class="robot-state st-${r.state}">${r.state.toUpperCase()}</div>
    `;
    list.appendChild(row);

    // Detect state changes → add to activity log
    const prev = prevRobotStates[r.id];
    if (prev && prev !== r.state) {
      const evColors = { moving: "cyan", charging: "", waiting: "red", idle: "", arrived: "green" };
      addLog(lastState?.step ?? 0, `UNIT-${r.id} → ${r.state.toUpperCase()}`, evColors[r.state] ?? "");
    }
    prevRobotStates[r.id] = r.state;
  }
}


/* ════════════════════════════════════════════════════════════════════════════
   UI LOGIC
   ════════════════════════════════════════════════════════════════════════════ */

// ─── Application state ────────────────────────────────────────────────────────
let viewMode = "sim";       // "sim" | "heat"
let currentTaskMode = "warehouse"; // "warehouse" | "random" | "target"
let lastState = null;        // most-recent server snapshot
let prevKpi = {};
let prevRobotStates = {};
let maxDist = 1, maxTasks = 1, maxConflicts = 1, maxAvgTime = 1;
let logEntries = [];

/**
 * globalSpeed — the ONE global speed variable used by all robots.
 * Expressed as the slider value (1–10); converted to seconds/tick in setSpeed().
 */
let globalSpeed = 5;

// ─── Chart.js setup ──────────────────────────────────────────────────────────
let perfChart = null;
const chartHistory = { labels: [], tasks: [], conflicts: [], util: [] };
const MAX_HISTORY = 80;

function initChart() {
  const el = document.getElementById("perf-chart");
  if (!el || !window.Chart) return;
  if (perfChart) { perfChart.destroy(); perfChart = null; }
  perfChart = new Chart(el, {
    type: "line",
    data: {
      labels: chartHistory.labels,
      datasets: [
        {
          label: "Tasks Done", data: chartHistory.tasks,
          borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.07)",
          borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true, yAxisID: "yCount",
        },
        {
          label: "Conflicts ✓", data: chartHistory.conflicts,
          borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,0.05)",
          borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true, yAxisID: "yCount",
        },
        {
          label: "Util %", data: chartHistory.util,
          borderColor: "#06b6d4", backgroundColor: "transparent",
          borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: false, yAxisID: "yPct",
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#7a9bb5", font: { family: "'Share Tech Mono', monospace", size: 8 }, boxWidth: 8, padding: 8 } },
      },
      scales: {
        x: { ticks: { display: false }, grid: { color: "rgba(30,45,61,0.6)", lineWidth: 0.5 } },
        yCount: { position: "left", ticks: { color: "#3d5a73", font: { size: 8, family: "'Share Tech Mono', monospace" }, maxTicksLimit: 4 }, grid: { color: "rgba(30,45,61,0.6)", lineWidth: 0.5 } },
        yPct: { position: "right", min: 0, max: 100, ticks: { color: "#3d5a73", font: { size: 8, family: "'Share Tech Mono', monospace" }, maxTicksLimit: 3 }, grid: { display: false } },
      },
    },
  });
}

function updateChart(kpi, step) {
  if (!perfChart) return;
  chartHistory.labels.push(step);
  chartHistory.tasks.push(kpi.tasks_done);
  chartHistory.conflicts.push(kpi.conflicts);
  chartHistory.util.push(kpi.util_pct);
  if (chartHistory.labels.length > MAX_HISTORY) {
    chartHistory.labels.shift(); chartHistory.tasks.shift();
    chartHistory.conflicts.shift(); chartHistory.util.shift();
  }
  perfChart.update("none");
}

function resetChart() {
  chartHistory.labels.length = chartHistory.tasks.length =
    chartHistory.conflicts.length = chartHistory.util.length = 0;
  if (perfChart) perfChart.update("none");
}

// ─── KPI panel ───────────────────────────────────────────────────────────────

function updateKPIs(kpi, step) {
  maxDist = Math.max(maxDist, kpi.total_dist + 1);
  maxTasks = Math.max(maxTasks, kpi.tasks_done + 1);
  maxConflicts = Math.max(maxConflicts, kpi.conflicts + 1);
  maxAvgTime = Math.max(maxAvgTime, (kpi.avg_task_time || 0) + 1);

  setKpi("tasks", kpi.tasks_done, kpi.tasks_done / maxTasks * 100, "green");
  setKpi("pending", kpi.pending, Math.min(kpi.pending / 25 * 100, 100), "cyan");
  setKpi("conflicts", kpi.conflicts, kpi.conflicts / maxConflicts * 100, "amber");
  setKpi("eff", kpi.efficiency.toFixed(2), Math.min(kpi.efficiency / 20 * 100, 100), "cyan");
  setKpi("util", kpi.util_pct + '<span class="kpi-unit">%</span>', kpi.util_pct, "amber");
  setKpi("dist", kpi.total_dist, kpi.total_dist / maxDist * 100, "cyan");
  const at = kpi.avg_task_time || 0;
  setKpi("avgtime", at + '<span class="kpi-unit"> steps</span>', Math.min(at / maxAvgTime * 100, 100), "");

  document.getElementById("step-display").textContent = "STEP: " + String(step).padStart(4, "0");
}

function setKpi(key, val, pct, cls) {
  const kv = document.getElementById(`kv-${key}`);
  const kb = document.getElementById(`kb-${key}`);
  const card = document.getElementById(`kpi-${key}`);
  if (!kv) return;
  if (String(val) !== String(prevKpi[key])) {
    kv.innerHTML = String(val);
    card.classList.remove("pulse");
    void card.offsetWidth;
    card.classList.add("pulse");
    prevKpi[key] = val;
  }
  if (kb) kb.style.width = Math.min(pct, 100) + "%";
}

// ─── Activity log ─────────────────────────────────────────────────────────────

function addLog(step, msg, cls = "") {
  logEntries.unshift({ step, msg, cls });
  if (logEntries.length > 40) logEntries.pop();
  const list = document.getElementById("log-list");
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML =
    `<span class="log-step">[${String(step).padStart(4, "0")}]</span>`
    + `<span class="log-ev ${cls}">${msg}</span>`;
  list.insertBefore(entry, list.firstChild);
  while (list.children.length > 15) list.removeChild(list.lastChild);
}

// ─── Capacity warning banner ──────────────────────────────────────────────────

function showCapacityWarning(placed, requested, capacity) {
  const banner = document.getElementById("capacity-warning");
  if (requested > capacity) {
    document.getElementById("cap-max").textContent = capacity;
    document.getElementById("cap-placed").textContent = placed;
    document.getElementById("cap-req").textContent = requested;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

// ─── Target mode banner ───────────────────────────────────────────────────────

function updateTargetBanner(state) {
  const banner = document.getElementById("target-banner");
  if (state.task_mode === "target") {
    banner.classList.remove("hidden");
    document.getElementById("target-reached-count").textContent = state.target_reached ?? 0;
    document.getElementById("target-total-count").textContent = state.total_robots ?? 0;
  } else {
    banner.classList.add("hidden");
  }
}

// ─── API Polling ─────────────────────────────────────────────────────────────
/**
 * Poll the server every 200 ms for the latest simulation snapshot.
 * The server controls timing via `_sim_speed` (the global speed variable).
 */
async function poll() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    if (!state.ready) return;
    lastState = state;

    render(state);
    updateKPIs(state.kpi, state.step);
    updateRobotList(state.robots);
    updateTargetBanner(state);

    if (state.running) updateChart(state.kpi, state.step);

    // Enable "+ TASK" button only in warehouse mode
    const addBtn = document.getElementById("btn-add-task");
    if (addBtn) addBtn.disabled = !(state.running && state.task_mode === "warehouse");

    // Log task completions
    if (state.kpi.tasks_done > (prevKpi._tasksRaw || 0)) {
      addLog(state.step, "TASK COMPLETED  ✓", "green");
    }
    prevKpi._tasksRaw = state.kpi.tasks_done;

    // Sync task-mode buttons if backend changed mode
    if (state.task_mode && state.task_mode !== currentTaskMode) {
      currentTaskMode = state.task_mode;
      _syncTaskModeButtons(currentTaskMode);
    }

  } catch (e) { /* server not ready yet */ }
}

// ─── Canvas interaction ──────────────────────────────────────────────────────

canvas.addEventListener("click", async (e) => {
  const cs = canvas._cell;
  const rect = canvas.getBoundingClientRect();
  const c = Math.floor((e.clientX - rect.left) / cs);
  const r = Math.floor((e.clientY - rect.top) / cs);
  if (r < 0 || r >= GRID_H || c < 0 || c >= GRID_W) return;
  if (!lastState || !lastState.running) return;

  if (currentTaskMode === "target") {
    // In target mode: clicks set the shared target cell
    const res = await fetch("/api/set_target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ r, c }),
    });
    const data = await res.json();
    if (data.ok) {
      addLog(lastState.step, `TARGET → (${r},${c})`, "green");
    }
  } else {
    // Warehouse / random mode: clicks add obstacles
    const res = await fetch("/api/add_obstacle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ r, c }),
    });
    const data = await res.json();
    if (data.ok) {
      addLog(lastState.step, `OBSTACLE @(${r},${c})`, "red");
    }
  }
});

canvas.addEventListener("mousemove", (e) => {
  if (!lastState) return;
  const cs = canvas._cell;
  const rect = canvas.getBoundingClientRect();
  const c = Math.floor((e.clientX - rect.left) / cs);
  const r = Math.floor((e.clientY - rect.top) / cs);
  if (r < 0 || r >= GRID_H || c < 0 || c >= GRID_W) {
    document.getElementById("tooltip").style.display = "none";
    return;
  }
  const tip = document.getElementById("tooltip");
  const ct = lastState.grid[r][c];
  const hm = lastState.heatmap[r][c];
  const types = { 0: "Empty", 1: "Obstacle", 2: "Pickup", 3: "Drop-off", 4: "Charger", 5: "TARGET" };
  const robot = lastState.robots.find(rb => rb.pos[0] === r && rb.pos[1] === c);

  let html = `(${r},${c}) — ${types[ct] ?? "?"} — visits:${hm}`;
  if (robot) html += `<br>UNIT-${robot.id} · ${robot.state} · batt:${robot.battery}%`;

  tip.innerHTML = html;
  tip.style.display = "block";
  tip.style.left = (e.clientX + 14) + "px";
  tip.style.top = (e.clientY - 10) + "px";
});

canvas.addEventListener("mouseleave", () => {
  document.getElementById("tooltip").style.display = "none";
});

// ─── View mode (SIM / HEAT) ───────────────────────────────────────────────────

function setMode(m) {
  viewMode = m;
  document.getElementById("mode-sim").classList.toggle("active", m === "sim");
  document.getElementById("mode-heat").classList.toggle("active", m === "heat");
  if (lastState) render(lastState);
}

// ─── Pause / Resume ───────────────────────────────────────────────────────────

async function togglePause() {
  const res = await fetch("/api/pause", { method: "POST" });
  const data = await res.json();
  document.getElementById("btn-pause").textContent = data.paused ? "RESUME" : "PAUSE";
  addLog(lastState?.step ?? 0, data.paused ? "SIMULATION PAUSED" : "SIMULATION RESUMED");
}

// ─── Reset ────────────────────────────────────────────────────────────────────

async function resetSim() {
  prevRobotStates = {};
  prevKpi = {};
  maxDist = maxTasks = maxConflicts = maxAvgTime = 1;
  document.getElementById("log-list").innerHTML = "";
  resetChart();

  await fetch("/api/reset", { method: "POST" });
  document.getElementById("btn-pause").textContent = "PAUSE";
  const addBtn = document.getElementById("btn-add-task");
  if (addBtn) addBtn.disabled = true;
  document.getElementById("capacity-warning").classList.add("hidden");
  addLog(0, "SYSTEM RESET", "cyan");
}

// ─── Launch (from overlay) ────────────────────────────────────────────────────

async function launchSim() {
  const n = parseInt(document.getElementById("cfg-robots").value) || 4;
  const si = parseInt(document.getElementById("cfg-spawn").value) || 8;
  await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ num_robots: n, spawn_interval: si, task_mode: currentTaskMode }),
  });

  document.getElementById("overlay").classList.add("hidden");
  setTimeout(() => document.getElementById("overlay").remove(), 600);

  initChart();
  addLog(0, "SYSTEM ONLINE", "green");
  addLog(0, `DEPLOYING ${n} UNITS · MODE: ${currentTaskMode.toUpperCase()}`, "cyan");
}

document.getElementById("launch-btn").addEventListener("click", launchSim);

// ─── Add Warehouse Task ───────────────────────────────────────────────────────

async function addTask() {
  const res = await fetch("/api/add_task", { method: "POST" });
  const data = await res.json();
  if (data.ok) {
    addLog(lastState?.step ?? 0, "TASK INJECTED MANUALLY", "cyan");
  } else {
    addLog(lastState?.step ?? 0, "TASK REJECTED — sim not running / wrong mode", "red");
  }
}

// ─── GLOBAL SPEED CONTROL ─────────────────────────────────────────────────────
/**
 * setSpeed(val) — called whenever the speed slider changes.
 * `val` is 1–10.  We convert it to seconds-per-tick and POST to /api/speed.
 * ALL robots share this ONE global speed variable — there is no per-robot speed.
 */
function setSpeed(val) {
  globalSpeed = parseInt(val);   // global speed variable
  // Map slider 1 (slowest → 2s/tick) … 10 (fastest → 0.05s/tick)
  const secondsPerTick = 2.0 - (globalSpeed - 1) / 9 * (2.0 - 0.05);
  document.getElementById("cfg-speed-val").textContent = val + "×";
  fetch("/api/speed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speed: secondsPerTick }),
  });
}

// ─── DYNAMIC ROBOT COUNT ─────────────────────────────────────────────────────
/**
 * Called while the user is typing in the number input.
 * Just updates the display without rebuilding yet.
 */
function onRobotCountInput(val) {
  // Could show a live preview — for now just validate range
  const n = parseInt(val);
  const input = document.getElementById("cfg-robots");
  if (isNaN(n) || n < 1) input.classList.add("input-invalid");
  else input.classList.remove("input-invalid");
}

/**
 * Called on blur or Enter — rebuilds the simulation with the new robot count.
 * Shows a warning if the grid can't fit all requested robots.
 */
async function applyRobotCount() {
  const rawVal = document.getElementById("cfg-robots").value;
  const n = parseInt(rawVal);
  if (isNaN(n) || n < 1) return;

  const si = parseInt(document.getElementById("cfg-spawn").value) || 8;

  const res = await fetch("/api/set_robots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ num_robots: n, spawn_interval: si }),
  });
  const data = await res.json();

  showCapacityWarning(data.placed, data.requested, data.capacity);
  addLog(lastState?.step ?? 0, `FLEET RESIZED → ${data.placed} UNITS`, "cyan");
  if (data.warning) {
    addLog(lastState?.step ?? 0,
      `⚠ CAPACITY: grid holds ${data.capacity}, requested ${data.requested}`, "red");
  }
}

// ─── TASK MODE SELECTION ─────────────────────────────────────────────────────
/**
 * setTaskMode('random' | 'target' | 'warehouse')
 * Sends the new mode to the server and updates the UI buttons.
 *
 * Task 1: Random Movement  — robots wander randomly, no overlap
 * Task 2: Target Reaching  — robots navigate to one shared target cell
 */
async function setTaskMode(mode) {
  currentTaskMode = mode;
  _syncTaskModeButtons(mode);

  await fetch("/api/set_task_mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });

  const labels = { warehouse: "WAREHOUSE MODE", random: "RANDOM MOVEMENT", target: "TARGET REACHING" };
  addLog(lastState?.step ?? 0, labels[mode] ?? mode.toUpperCase(), "cyan");

  // Show/hide banners
  document.getElementById("target-banner").classList.toggle("hidden", mode !== "target");
  document.getElementById("capacity-warning").classList.add("hidden");

  // Disable "+ TASK" button outside warehouse mode
  const addBtn = document.getElementById("btn-add-task");
  if (addBtn) addBtn.disabled = mode !== "warehouse";
}

function _syncTaskModeButtons(mode) {
  ["warehouse", "random", "target"].forEach(m => {
    document.getElementById(`task-btn-${m}`)?.classList.toggle("active", m === mode);
  });
}

// ─── Initial grid preview ─────────────────────────────────────────────────────
/**
 * Build grid + place robots on page load so they're visible
 * behind the startup overlay before the user clicks "INITIALISE SYSTEM".
 */
async function previewGrid() {
  const n = parseInt(document.getElementById("cfg-robots").value) || 4;
  const si = parseInt(document.getElementById("cfg-spawn").value) || 8;
  const res = await fetch("/api/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ num_robots: n, spawn_interval: si, task_mode: currentTaskMode }),
  });
  const data = await res.json();
  showCapacityWarning(data.placed, data.requested, data.capacity || 100);
  await poll();  // immediately render the grid behind the overlay
}

// ─── Start polling every 200 ms ───────────────────────────────────────────────
setInterval(poll, 200);

// On page load: size canvas, preview the grid
resizeCanvas();
previewGrid();
