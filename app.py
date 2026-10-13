"""
IntelliFleet Web App — Flask Backend
=====================================
Endpoints
---------
GET  /                → main HTML page
POST /api/init        → build grid + place robots (preview, not running)
POST /api/start       → (re)start simulation
POST /api/pause       → toggle pause
POST /api/reset       → full reset
GET  /api/state       → snapshot polled by the frontend
POST /api/add_obstacle→ inject a dynamic obstacle
POST /api/add_task    → manually add a task (warehouse mode)
POST /api/speed       → set global tick speed
POST /api/set_task_mode → switch between 'random', 'target', 'warehouse'
POST /api/set_target  → set the target cell for target-reaching mode
POST /api/set_robots  → change robot count (rebuilds sim)
"""

import json
import random
import time
import threading
from flask import Flask, jsonify, request, render_template

app = Flask(__name__)

# ─── Global sim state ────────────────────────────────────────────────────────
_lock      = threading.Lock()
_sim       = None          # SimulationEngine instance
_sim_speed = 0.25          # seconds per tick (global speed variable)


# ══════════════════════════════════════════════════════════════════════════════
#  GRID / ROBOT CONSTANTS
# ══════════════════════════════════════════════════════════════════════════════

GRID_W, GRID_H = 10, 10
EMPTY, OBSTACLE, PICKUP, DROPOFF, CHARGER, TARGET = 0, 1, 2, 3, 4, 5

BATTERY_MAX        = 100.0
BATTERY_DRAIN_MOVE = 1.2
BATTERY_DRAIN_IDLE = 0.15
BATTERY_CHARGE     = 6.0
BATTERY_LOW        = 22.0

# Eight distinct robot colours — enough for up to 8; cycles if more are needed
ROBOT_COLORS = [
    "#ef4444", "#3b82f6", "#22c55e", "#f59e0b",
    "#a855f7", "#06b6d4", "#ec4899", "#84cc16",
    "#ff7849", "#38bdf8", "#4ade80", "#facc15",
]


# ══════════════════════════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def manhattan(a, b):
    """Manhattan distance between two (row,col) tuples."""
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def a_star(start, goal, grid, blocked=None):
    """
    A* pathfinding on the 2-D grid.
    Returns the path (excluding start, including goal) or [] if unreachable.
    `blocked` is an optional set of cells that count as impassable
    (except the goal itself).
    """
    import heapq
    if start == goal:
        return []
    blocked = blocked or set()
    rows, cols = len(grid), len(grid[0])

    def passable(p):
        r, c = p
        return (
            0 <= r < rows and 0 <= c < cols
            and grid[r][c] != OBSTACLE
            and (p not in blocked or p == goal)
        )

    h = lambda p: abs(p[0] - goal[0]) + abs(p[1] - goal[1])
    heap = [(h(start), 0, start)]
    came = {start: None}
    g_cost = {start: 0}
    visited = set()

    while heap:
        _, gc, cur = heapq.heappop(heap)
        if cur == goal:
            path, node = [], cur
            while came[node]:
                path.append(node)
                node = came[node]
            return list(reversed(path))
        if cur in visited:
            continue
        visited.add(cur)
        r, c = cur
        for nr, nc in [(r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)]:
            nb = (nr, nc)
            if not passable(nb) or nb in visited:
                continue
            ng = gc + 1
            if ng < g_cost.get(nb, 1e9):
                g_cost[nb] = ng
                came[nb] = cur
                heapq.heappush(heap, (ng + h(nb), ng, nb))
    return []


# ══════════════════════════════════════════════════════════════════════════════
#  TASK (warehouse mode only)
# ══════════════════════════════════════════════════════════════════════════════

class Task:
    _ctr = 0

    def __init__(self, origin, dest, step, pri=1):
        Task._ctr += 1
        self.id = Task._ctr
        self.origin, self.dest = origin, dest
        self.created = step
        self.assigned_step = None
        self.completed_step = None
        self.status = "pending"   # pending / assigned / done
        self.robot_id = None
        self.priority = pri

    def assign(self, rid, step):
        self.robot_id = rid
        self.assigned_step = step
        self.status = "assigned"

    def complete(self, step):
        self.completed_step = step
        self.status = "done"

    def unassign(self):
        self.robot_id = None
        self.assigned_step = None
        self.status = "pending"


# ══════════════════════════════════════════════════════════════════════════════
#  ROBOT
# ══════════════════════════════════════════════════════════════════════════════

class Robot:
    """
    A single robot agent.

    Supports three operating modes set by SimulationEngine.task_mode:
      'random'    — moves to a random adjacent empty cell each tick
      'target'    — uses A* to reach a shared target cell, stops on arrival
      'warehouse' — full task-assignment / A* / battery logic
    """

    def __init__(self, rid, pos):
        self.id    = rid
        self.pos   = pos                             # (row, col) tuple
        self.color = ROBOT_COLORS[rid % len(ROBOT_COLORS)]

        # --- Warehouse / target motion ---
        self.path   = []        # planned path (list of (r,c), excl. current pos)
        self.target = None      # current destination cell

        # --- Battery (warehouse mode) ---
        self.battery  = BATTERY_MAX
        self.state    = "idle"  # idle / moving / charging / waiting / arrived

        # --- Statistics ---
        self.tasks_done = 0
        self.dist_total = 0
        self.wait_steps = 0
        self.completed_task_times = []

        # --- Warehouse internals ---
        self.task             = None
        self.priority         = (rid % 3) + 1
        self._charger_target  = None
        self.task_start_step  = None

    # ── Path helpers ──────────────────────────────────────────────────────────

    def peek(self):
        """Return the next cell we intend to move to, without moving."""
        return self.path[0] if self.path else self.pos

    def confirm(self, step):
        """Commit to moving one cell along the planned path."""
        if not self.path:
            return
        self.pos = self.path.pop(0)
        self.dist_total += 1
        if self.pos == self.target:
            self._on_arrive(step)

    def deny(self):
        """Collision coordinator told us to wait this tick."""
        self.state = "waiting"
        self.wait_steps += 1

    def resume(self):
        if self.state == "waiting" and self.path:
            self.state = "moving"

    # ── Random movement ───────────────────────────────────────────────────────

    def random_step(self, grid, occupied):
        """
        Move to a random adjacent empty cell that is not currently occupied
        by another robot.  Returns the new position (or stays put).
        """
        r, c = self.pos
        neighbours = []
        for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nr, nc = r + dr, c + dc
            if (0 <= nr < GRID_H and 0 <= nc < GRID_W
                    and grid[nr][nc] not in (OBSTACLE,)
                    and (nr, nc) not in occupied):
                neighbours.append((nr, nc))
        if neighbours:
            chosen = random.choice(neighbours)
            occupied.discard(self.pos)
            self.pos = chosen
            occupied.add(self.pos)
            self.dist_total += 1
            self.state = "moving"
        else:
            self.state = "waiting"
            self.wait_steps += 1
        return self.pos

    # ── Warehouse helpers ─────────────────────────────────────────────────────

    def assign_task(self, task, path, step):
        self.task = task
        self.target = task.dest
        self.task_start_step = step
        self.path = path
        self.state = "moving"

    def _on_arrive(self, step):
        if self._charger_target and self.pos == self._charger_target:
            self.state = "charging"
            return
        if self.task:
            duration = max(0, step - (self.task_start_step or step))
            self.completed_task_times.append(duration)
            self.task.complete(step)
            self.tasks_done += 1
            self.task = None
        self.target = None
        self.state = "arrived" if self.state != "charging" else "charging"
        # 'arrived' will be reset to 'idle' by the engine after all robots checked

    def battery_tick(self, grid, charger_cells):
        if self.state == "charging":
            self.battery = min(BATTERY_MAX, self.battery + BATTERY_CHARGE)
            if self.battery >= BATTERY_MAX:
                self.state = "idle"
                self._charger_target = None
            return
        self.battery -= BATTERY_DRAIN_MOVE if self.state == "moving" else BATTERY_DRAIN_IDLE
        self.battery = max(0, self.battery)
        if self.battery <= BATTERY_LOW and self.state != "charging":
            self._goto_charger(grid, charger_cells)

    def _goto_charger(self, grid, charger_cells):
        best = min(charger_cells, key=lambda c: manhattan(self.pos, c))
        p = a_star(self.pos, best, grid)
        if p:
            self.path = p
            self.target = best
            self._charger_target = best
            self.state = "moving"
            if self.task:
                self.task.unassign()
                self.task = None

    # ── Serialise ─────────────────────────────────────────────────────────────

    def to_dict(self):
        times = self.completed_task_times
        avg_t = round(sum(times) / len(times), 1) if times else 0
        eff   = round(self.tasks_done / max(self.dist_total, 1) * 100, 1)
        return {
            "id":         self.id,
            "pos":        list(self.pos),
            "color":      self.color,
            "state":      self.state,
            "battery":    round(self.battery, 1),
            "path":       [list(p) for p in self.path[:10]],
            "tasks_done": self.tasks_done,
            "dist":       self.dist_total,
            "wait":       self.wait_steps,
            "efficiency": eff,
            "avg_task_time": avg_t,
            "task": (
                {"origin": list(self.task.origin), "dest": list(self.task.dest)}
                if self.task else None
            ),
        }


# ══════════════════════════════════════════════════════════════════════════════
#  SIMULATION ENGINE
# ══════════════════════════════════════════════════════════════════════════════

class SimulationEngine:
    """
    Central engine.  Supports three task modes:
      'warehouse' — classic task-assignment / A* / battery system
      'random'    — all robots do random walks (no overlap)
      'target'    — all robots move toward one shared target cell via A*
                    and stop when they reach it
    """

    def __init__(self, num_robots=4, spawn_interval=8, task_mode="warehouse"):
        Task._ctr = 0
        self.num_robots     = num_robots
        self.spawn_interval = spawn_interval
        self.step    = 0
        self.paused  = False
        self.running = False

        # Task mode: 'warehouse' | 'random' | 'target'
        self.task_mode = task_mode

        # Build the static grid
        self.grid = self._build_grid()

        # Special cells (warehouse mode)
        self.pickups  = [(0, 0), (0, 5), (5, 0)]
        self.dropoffs = [(9, 9), (9, 4), (4, 9)]
        self.chargers = [(0, 9), (9, 0)]
        for r, c in self.pickups:  self.grid[r][c] = PICKUP
        for r, c in self.dropoffs: self.grid[r][c] = DROPOFF
        for r, c in self.chargers: self.grid[r][c] = CHARGER

        # Target cell for 'target' mode (default: centre of grid)
        self.target_cell = (4, 4)

        self.heatmap = [[0] * GRID_W for _ in range(GRID_H)]

        # Global array of robots
        self.robots = self._place_robots()

        # Warehouse task queue
        self.pending   = []
        self.completed = []
        self.conflicts_prevented = 0
        self.dyn_obstacles = []   # [(pos, inserted_step)]

        # Track which robots have reached the target (target mode)
        self.target_reached_ids = set()

    # ── Grid construction ──────────────────────────────────────────────────────

    def _build_grid(self):
        g = [[EMPTY] * GRID_W for _ in range(GRID_H)]
        # Fixed obstacle walls
        for r in [2, 3]:
            for c in range(2, 5):
                g[r][c] = OBSTACLE
        for r in [6, 7]:
            for c in range(5, 8):
                g[r][c] = OBSTACLE
        # A few random extra obstacles (fixed seed for reproducibility)
        rng = random.Random(42)
        placed = 0
        while placed < 4:
            r = rng.randint(1, GRID_H - 2)
            c = rng.randint(1, GRID_W - 2)
            if g[r][c] == EMPTY:
                g[r][c] = OBSTACLE
                placed += 1
        return g

    def _free_cells(self, exclude=None):
        ex = exclude or set()
        return [
            (r, c)
            for r in range(GRID_H)
            for c in range(GRID_W)
            if self.grid[r][c] == EMPTY and (r, c) not in ex
        ]

    def available_cells(self):
        """Count of cells that can hold a robot (empty, pickup, dropoff, charger)."""
        count = 0
        for r in range(GRID_H):
            for c in range(GRID_W):
                if self.grid[r][c] != OBSTACLE:
                    count += 1
        return count

    def _place_robots(self):
        """
        Place `num_robots` robots in distinct empty cells.
        Returns a list — this is the ONE global robot array.
        """
        free = self._free_cells()
        random.shuffle(free)
        capacity = len(free)
        count = min(self.num_robots, capacity)
        robots = []
        for i in range(count):
            robots.append(Robot(i, free[i]))
        return robots

    # ── Warehouse: task spawning / assignment ─────────────────────────────────

    def _maybe_spawn(self):
        if self.step % self.spawn_interval == 0 and len(self.pending) < 25:
            o = random.choice(self.pickups)
            d = random.choice(self.dropoffs)
            if o != d:
                self.pending.append(Task(o, d, self.step, random.randint(1, 3)))

    def _assign_tasks(self):
        idle = [r for r in self.robots if r.state == "idle" and r.task is None]
        self.pending.sort(key=lambda t: t.priority)
        still = []
        assigned_ids = set()
        for task in self.pending:
            avail = [r for r in idle if r.id not in assigned_ids]
            if not avail:
                still.append(task)
                continue
            best = min(avail, key=lambda r: manhattan(r.pos, task.origin))
            p1 = a_star(best.pos, task.origin, self.grid)
            p2 = a_star(task.origin, task.dest, self.grid)
            if (p1 or best.pos == task.origin) and (p2 or task.origin == task.dest):
                full = (
                    (p1 if best.pos != task.origin else [])
                    + (p2 if task.origin != task.dest else [])
                )
                task.assign(best.id, self.step)
                best.assign_task(task, full, self.step)
                assigned_ids.add(best.id)
            else:
                still.append(task)
        self.pending = still

    # ── Warehouse: collision coordination ────────────────────────────────────

    def _coordinate_warehouse(self):
        reservations = {r.pos: r.id for r in self.robots}
        intentions = {}

        for robot in self.robots:
            robot.battery_tick(self.grid, self.chargers)
            if robot.state == "moving":
                robot.resume()
                intentions[robot.id] = (robot, robot.peek())

        pos_map = {}
        for rid, (rob, nxt) in intentions.items():
            if nxt != rob.pos:
                pos_map.setdefault(nxt, []).append(rob)

        denied = set()
        for pos, contenders in pos_map.items():
            occupant_id = reservations.get(pos)
            if occupant_id is not None:
                occupant = next((r for r in self.robots if r.id == occupant_id), None)
                if occupant and occupant.id in intentions:
                    _, occ_next = intentions[occupant.id]
                    for rob in contenders:
                        if occ_next == rob.pos:
                            loser = rob if rob.priority > occupant.priority else occupant
                            denied.add(loser.id)
                            self.conflicts_prevented += 1
            if len(contenders) > 1:
                winner = min(contenders, key=lambda r: (r.priority, r.id))
                for rob in contenders:
                    if rob.id != winner.id and rob.id not in denied:
                        denied.add(rob.id)
                        self.conflicts_prevented += 1

        for rid, (rob, nxt) in intentions.items():
            if rid in denied:
                rob.deny()
            elif nxt != rob.pos:
                rob.confirm(self.step)
                self.heatmap[rob.pos[0]][rob.pos[1]] += 1

        # Deadlock resolution
        blocked = set(reservations.keys())
        for rob in self.robots:
            if rob.state == "waiting" and rob.wait_steps >= 6:
                np = a_star(rob.pos, rob.target, self.grid, blocked=blocked)
                if np:
                    rob.path = np
                    rob.state = "moving"
                    rob.wait_steps = 0
                else:
                    rob.state = "idle"
                    rob.target = None
                    rob.path = []
                    if rob.task:
                        rob.task.unassign()
                        rob.task = None

        # Reset 'arrived' → 'idle' so they pick up new tasks
        for rob in self.robots:
            if rob.state == "arrived":
                rob.state = "idle"

    # ── Random movement mode ──────────────────────────────────────────────────

    def _tick_random(self):
        """
        Each robot independently tries to move to a random adjacent empty cell.
        No two robots may occupy the same cell.
        """
        occupied = {r.pos for r in self.robots}
        for robot in self.robots:
            robot.random_step(self.grid, occupied)
            self.heatmap[robot.pos[0]][robot.pos[1]] += 1

    # ── Target-reaching mode ──────────────────────────────────────────────────

    def _tick_target(self):
        """
        All robots use A* toward self.target_cell.
        Robots that have already arrived stay put.
        Simple one-at-a-time move with collision avoidance.
        """
        tc = self.target_cell

        # Re-plan paths for robots that don't have one yet
        occupied_positions = {r.pos for r in self.robots}

        for robot in self.robots:
            if robot.id in self.target_reached_ids:
                robot.state = "arrived"
                continue

            # Reached the target this tick or last tick?
            if robot.pos == tc:
                self.target_reached_ids.add(robot.id)
                robot.state = "arrived"
                robot.path  = []
                robot.target = tc
                continue

            # Need a path?
            if not robot.path:
                # Block cells occupied by OTHER robots so we don't collide
                others = occupied_positions - {robot.pos}
                robot.path = a_star(robot.pos, tc, self.grid, blocked=others)
                robot.target = tc
                if robot.path:
                    robot.state = "moving"
                else:
                    robot.state = "waiting"
                    robot.wait_steps += 1

        # Move all robots one step (simple sequential — good enough for demo)
        # Use reservations to avoid two robots landing on the same cell.
        next_positions = {}   # robot.id → next_pos
        reserved = set()

        for robot in self.robots:
            if robot.id in self.target_reached_ids:
                reserved.add(robot.pos)
                next_positions[robot.id] = robot.pos
                continue
            if robot.path:
                candidate = robot.path[0]
                if candidate not in reserved:
                    next_positions[robot.id] = candidate
                    reserved.add(candidate)
                else:
                    # Cell taken — stay put this tick, re-plan next tick
                    next_positions[robot.id] = robot.pos
                    robot.path = []    # will re-plan next tick
                    robot.state = "waiting"
                    robot.wait_steps += 1
            else:
                next_positions[robot.id] = robot.pos

        for robot in self.robots:
            new_pos = next_positions.get(robot.id, robot.pos)
            if new_pos != robot.pos:
                robot.path.pop(0)
                robot.dist_total += 1
                robot.pos = new_pos
                self.heatmap[new_pos[0]][new_pos[1]] += 1
                if new_pos == tc:
                    self.target_reached_ids.add(robot.id)
                    robot.state = "arrived"
                    robot.path  = []
                else:
                    robot.state = "moving"

    # ── Dynamic obstacles ─────────────────────────────────────────────────────

    def add_obstacle(self, pos):
        r, c = pos
        if self.grid[r][c] == EMPTY:
            self.grid[r][c] = OBSTACLE
            self.dyn_obstacles.append((pos, self.step))
            # Invalidate paths that go through the new obstacle
            for rob in self.robots:
                if pos in rob.path:
                    rob.path = []
            return True
        return False

    def _expire_obstacles(self):
        still = []
        for pos, inserted in self.dyn_obstacles:
            if self.step - inserted >= 40:
                r, c = pos
                self.grid[r][c] = EMPTY
            else:
                still.append((pos, inserted))
        self.dyn_obstacles = still

    # ── Manual task injection (warehouse mode) ────────────────────────────────

    def add_task(self, origin=None, dest=None, priority=None):
        o = origin   if origin   else random.choice(self.pickups)
        d = dest     if dest     else random.choice(self.dropoffs)
        p = priority if priority else random.randint(1, 3)
        if o != d and len(self.pending) < 25:
            self.pending.append(Task(o, d, self.step, p))
            return True
        return False

    # ── Set target (target mode) ──────────────────────────────────────────────

    def set_target(self, row, col):
        """Move the shared target cell and reset arrived flags so robots re-pursue."""
        if self.grid[row][col] == OBSTACLE:
            return False
        self.target_cell = (row, col)
        self.target_reached_ids.clear()
        # Clear existing paths so robots re-plan toward new target
        for rob in self.robots:
            rob.path   = []
            rob.target = None
            if rob.state == "arrived":
                rob.state = "idle"
        return True

    # ── Main tick ─────────────────────────────────────────────────────────────

    def tick(self):
        if self.paused:
            return

        if self.task_mode == "random":
            self._tick_random()

        elif self.task_mode == "target":
            self._tick_target()

        else:  # 'warehouse'
            self._maybe_spawn()
            self._assign_tasks()
            self._coordinate_warehouse()
            self._expire_obstacles()

        self.step += 1

    # ── Snapshot (sent to frontend via /api/state) ────────────────────────────

    def snapshot(self):
        total_dist = sum(r.dist_total for r in self.robots)
        total_wait = sum(r.wait_steps for r in self.robots)
        denom      = max(self.step, 1) * max(self.num_robots, 1)
        util_pct   = round(total_dist / denom * 100, 1)
        done_count = sum(r.tasks_done for r in self.robots)
        idle_frac  = total_wait / denom
        efficiency = round(done_count / (1 + idle_frac), 2)

        all_times     = [t for r in self.robots for t in r.completed_task_times]
        avg_task_time = round(sum(all_times) / len(all_times), 1) if all_times else 0

        # Mark target cell in the grid snapshot so the frontend can colour it
        grid_snapshot = [row[:] for row in self.grid]  # deep copy
        if self.task_mode == "target":
            tr, tc = self.target_cell
            if grid_snapshot[tr][tc] not in (OBSTACLE,):
                grid_snapshot[tr][tc] = TARGET   # cell type 5

        # How many robots have reached the target?
        reached = len(self.target_reached_ids)
        total_r = len(self.robots)

        return {
            "step":    self.step,
            "paused":  self.paused,
            "running": self.running,
            "robots":  [r.to_dict() for r in self.robots],
            "grid":    grid_snapshot,
            "heatmap": self.heatmap,
            "task_mode":   self.task_mode,
            "target_cell": list(self.target_cell),
            "target_reached": reached,
            "total_robots":   total_r,
            "kpi": {
                "tasks_done":    done_count,
                "pending":       len(self.pending),
                "conflicts":     self.conflicts_prevented,
                "util_pct":      util_pct,
                "idle_pct":      round(total_wait / denom * 100, 1),
                "efficiency":    efficiency,
                "total_dist":    total_dist,
                "avg_task_time": avg_task_time,
            },
        }


# ══════════════════════════════════════════════════════════════════════════════
#  BACKGROUND SIMULATION THREAD
#  Uses the GLOBAL _sim_speed variable — all robots share this single timing.
# ══════════════════════════════════════════════════════════════════════════════

def _sim_loop():
    global _sim, _sim_speed
    while True:
        time.sleep(_sim_speed)          # ← ONE global speed variable
        with _lock:
            if _sim and _sim.running and not _sim.paused:
                _sim.tick()


_thread = threading.Thread(target=_sim_loop, daemon=True)
_thread.start()


# ══════════════════════════════════════════════════════════════════════════════
#  FLASK ROUTES
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/init", methods=["POST"])
def init_sim():
    """Build grid + place robots but keep sim paused. Called on page load."""
    global _sim
    data = request.get_json(silent=True) or {}
    n    = int(data.get("num_robots", 4))
    si   = int(data.get("spawn_interval", 8))
    mode = str(data.get("task_mode", "warehouse"))

    # Safety: cap at grid capacity minus obstacles
    max_robots = GRID_W * GRID_H  # generous upper bound; engine will cap further
    n = max(1, min(n, max_robots))

    with _lock:
        _sim = SimulationEngine(num_robots=n, spawn_interval=si, task_mode=mode)
        _sim.running = False
    return jsonify({"ok": True, "placed": len(_sim.robots), "requested": n})


@app.route("/api/start", methods=["POST"])
def start():
    global _sim
    data = request.get_json(silent=True) or {}
    n    = int(data.get("num_robots", 4))
    si   = int(data.get("spawn_interval", 8))
    mode = str(data.get("task_mode", "warehouse"))
    with _lock:
        if _sim is None:
            _sim = SimulationEngine(num_robots=n, spawn_interval=si, task_mode=mode)
        _sim.running = True
        _sim.paused  = False
    return jsonify({"ok": True})


@app.route("/api/pause", methods=["POST"])
def pause():
    with _lock:
        if _sim:
            _sim.paused = not _sim.paused
            return jsonify({"paused": _sim.paused})
    return jsonify({"paused": False})


@app.route("/api/reset", methods=["POST"])
def reset():
    global _sim
    with _lock:
        if _sim:
            nr   = _sim.num_robots
            si   = _sim.spawn_interval
            mode = _sim.task_mode
        else:
            nr, si, mode = 4, 8, "warehouse"
        _sim = SimulationEngine(num_robots=nr, spawn_interval=si, task_mode=mode)
        _sim.running = False
    return jsonify({"ok": True})


@app.route("/api/state")
def state():
    with _lock:
        if not _sim:
            return jsonify({"ready": False})
        snap = _sim.snapshot()
        snap["ready"] = True
        return jsonify(snap)


@app.route("/api/add_obstacle", methods=["POST"])
def add_obstacle():
    data = request.get_json(silent=True) or {}
    pos  = (int(data["r"]), int(data["c"]))
    with _lock:
        if _sim:
            ok = _sim.add_obstacle(pos)
            return jsonify({"ok": ok})
    return jsonify({"ok": False})


@app.route("/api/add_task", methods=["POST"])
def add_task_route():
    """Manually inject a random task (warehouse mode only)."""
    with _lock:
        if _sim and _sim.running and _sim.task_mode == "warehouse":
            ok = _sim.add_task()
            return jsonify({"ok": ok})
    return jsonify({"ok": False})


@app.route("/api/speed", methods=["POST"])
def set_speed():
    """
    Adjust the global simulation speed.
    `speed` is seconds-per-tick; all robots share this one variable.
    """
    global _sim_speed
    data  = request.get_json(silent=True) or {}
    speed = float(data.get("speed", 0.25))
    _sim_speed = max(0.03, min(2.0, speed))
    return jsonify({"speed": round(_sim_speed, 3)})


@app.route("/api/set_task_mode", methods=["POST"])
def set_task_mode():
    """Switch the task mode without rebuilding everything."""
    data = request.get_json(silent=True) or {}
    mode = str(data.get("mode", "warehouse"))
    if mode not in ("random", "target", "warehouse"):
        return jsonify({"ok": False, "error": "unknown mode"})
    with _lock:
        if _sim:
            _sim.task_mode = mode
            # Clear warehouse tasks when switching to a non-warehouse mode
            if mode != "warehouse":
                _sim.pending = []
                for rob in _sim.robots:
                    rob.path   = []
                    rob.target = None
                    rob.task   = None
                    if rob.state not in ("idle", "arrived"):
                        rob.state = "idle"
            # Clear arrived flags when switching to target mode
            if mode == "target":
                _sim.target_reached_ids.clear()
            return jsonify({"ok": True, "mode": mode})
    return jsonify({"ok": False, "error": "no sim"})


@app.route("/api/set_target", methods=["POST"])
def set_target():
    """Set the shared target cell for target-reaching mode."""
    data = request.get_json(silent=True) or {}
    r = int(data.get("r", 4))
    c = int(data.get("c", 4))
    with _lock:
        if _sim:
            ok = _sim.set_target(r, c)
            return jsonify({"ok": ok, "target": [r, c]})
    return jsonify({"ok": False})


@app.route("/api/set_robots", methods=["POST"])
def set_robots():
    """
    Change the number of robots.  Rebuilds the simulation from scratch
    (same mode + spawn interval preserved).  Returns capacity info so the
    frontend can show a warning if the grid can't fit all requested robots.
    """
    global _sim
    data = request.get_json(silent=True) or {}
    n    = int(data.get("num_robots", 4))

    with _lock:
        si   = _sim.spawn_interval if _sim else 8
        mode = _sim.task_mode      if _sim else "warehouse"
        _sim = SimulationEngine(num_robots=n, spawn_interval=si, task_mode=mode)
        _sim.running = False
        placed    = len(_sim.robots)
        capacity  = _sim.available_cells()

    return jsonify({
        "ok":       True,
        "placed":   placed,
        "requested": n,
        "capacity": capacity,
        "warning":  n > capacity,
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
