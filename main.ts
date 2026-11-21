// sokoban-solver-01-run-20261121 — a push-optimal Sokoban solver for make.fun.
//
// How it works: every generated level is one hallway with small rooms off it, and a
// box pushed out of a room through its door can never come back, so each room is an
// independent problem. The solver splits a level into its rooms, solves each room
// push-optimally with A* over pushes, and stitches the rooms together with shortest
// player walks along the hallway.
//
// The search: a state is the boxes' squares plus the player's reachable region
// (named by its lowest square). A* orders states by pushes made plus an admissible
// heuristic — the cheapest assignment of boxes to goals by push-distance (a box's
// shortest push-path to a goal, ignoring the other boxes). Dead states are pruned
// with live squares (a box that can never be pushed onto a goal) and frozen 2x2
// blocks of walls and boxes. If A* runs out of its work budget, a greedy best-first
// pass tries for any solution at all, since a solved level at more pushes still
// scores, while an unsolved one scores nothing.
//
// Deterministic by construction: one fixed direction order, fixed tie-breaks, and a
// work budget counted in state expansions — never the clock, never randomness, and
// no reads of Date, the environment, or anything outside the input and output dirs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four moves in one fixed order: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r'];

// Work budgets in state expansions, shared across the set's five instances so the
// one 60-second wall is never approached. A room's A* gets a generous slice; the
// greedy fallback gets a smaller one.
const TOTAL_EXPANSIONS = 2_400_000;
const ROOM_EXPANSIONS = 600_000;
const FALLBACK_EXPANSIONS = 400_000;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = { boxes: number[]; goals: number[]; done: boolean };

/** A level in XSB text: its size, walls, goals, boxes and player square. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever a row shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box can still be pushed onto some goal: pull back from
 * the goals — a box at y can be pushed to x when y and the player's square y - d
 * are both open floor. A box off this set is dead wherever it stands.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const step = DY[k] * w + DX[k];
      const y = x - step;
      if (!wall[y] && !wall[y - step] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` around walls and `occupied` boxes. */
function floodRegion(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * Whether the box at `t` can never be pushed again: every direction is blocked by
 * a wall on the destination or on the square the player would stand on. Other
 * boxes moving can only open squares, so a wall-blocked box stays blocked. A box
 * on its goal is never a deadlock: it never needs to move again.
 */
function frozenBox(level: Level, goal: Uint8Array, t: number): boolean {
  if (goal[t]) return false;
  const { w, wall } = level;
  for (let k = 0; k < 4; k++) {
    const step = DY[k] * w + DX[k];
    if (!wall[t + step] && !wall[t - step]) return false;
  }
  return true;
}

/** The shortest walk from `from` to `to` around walls and boxes, in LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP[k];
      queue.push(q);
    }
  }
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after walking `moves` (LURD letters) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal (or, with `greedy`, best-first) solution of one (sub-)level:
 * { pushes, moves }, or null when the work budget runs out or the level has no
 * solution. A state is the boxes' squares and the player's region; the search
 * expands pushes, and with the admissible heuristic the first solved state it
 * takes off the open list is push-optimal. `pool` is the set-wide work budget,
 * spent an expansion at a time.
 */
function searchPushes(
  level: Level,
  budget: number,
  greedy: boolean,
  pool: { left: number },
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  // Push-distance from each goal: dist[gi * size + sq] is the fewest pushes a box
  // at sq needs to reach that goal, ignoring the other boxes. A box moves to a
  // neighbouring square when the square opposite it is open for the player.
  const dist = new Int32Array(goals.length * size).fill(-1);
  for (let gi = 0; gi < goals.length; gi++) {
    const base = gi * size;
    const queue = [goals[gi]];
    dist[base + goals[gi]] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const b = queue[qi];
      for (let k = 0; k < 4; k++) {
        const step = DY[k] * w + DX[k];
        const y = b - step;
        if (wall[y] || wall[y - step] || dist[base + y] >= 0) continue;
        dist[base + y] = dist[base + b] + 1;
        queue.push(y);
      }
    }
  }

  // Every ordering of the goals, for the cheapest box-to-goal assignment.
  const orders: number[][] = [];
  const buildOrders = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) {
      orders.push(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      buildOrders([...prefix, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  buildOrders([], goals.map((_, i) => i));

  // The heuristic: the cheapest assignment of boxes to distinct goals by
  // push-distance. Each push moves one box one square, so no solution from here
  // takes fewer pushes than this sum; Infinity when some box reaches no goal.
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const order of orders) {
      let sum = 0;
      for (let bi = 0; bi < n; bi++) {
        const d = dist[order[bi] * size + boxes[bi]];
        if (d < 0) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };

  // A state's key: its region's lowest square and the boxes' squares. Numeric
  // while the key stays exact (five boxes or fewer); a string for larger levels.
  const numericKey = n <= 5;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numericKey) return `${low}:${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states found: their boxes, the player's square, the pushes made, the
  // key they were filed under, and the push that made them from their parent
  // (direction and the box's old square).
  const statesBoxes: number[][] = [level.boxes.slice()];
  const statesPlayer: number[] = [level.player];
  const statesKey: (number | string)[] = [];
  const parent: number[] = [-1];
  const pushDir: number[] = [-1];
  const pushFrom: number[] = [-1];
  const bestG = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = floodRegion(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  statesKey.push(keyOf(level.boxes, startLow));
  bestG.set(statesKey[0], 0);

  // The open states, ordered by (f, deeper first, then first found): a binary
  // heap, so ties break the same way on every run.
  type HeapEntry = { f: number; g: number; seq: number; idx: number };
  const heap: HeapEntry[] = [];
  let seq = 0;
  const heapLess = (a: HeapEntry, b: HeapEntry): boolean =>
    a.f !== b.f ? a.f < b.f : a.g !== b.g ? a.g > b.g : a.seq < b.seq;
  const heapPush = (e: HeapEntry): void => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
    const top = heap[0];
    const last = heap.pop() as HeapEntry;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
        if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };

  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) return null;
  heapPush({ f: h0, g: 0, seq: seq++, idx: 0 });
  let expansions = 0;
  let found = -1;

  while (heap.length > 0) {
    const cur = heapPop();
    // Stale when a cheaper way to the same key has been filed since: the state
    // on the heap is no longer the best route to its own boxes and region.
    if (bestG.get(statesKey[cur.idx]) !== cur.g) continue;
    if (expansions >= budget || pool.left <= 0) return null;
    expansions++;
    pool.left--;
    const boxes = statesBoxes[cur.idx];
    if (solved(boxes)) {
      found = cur.idx;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    floodRegion(level, occupied, statesPlayer[cur.idx], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const step = DY[k] * w + DX[k];
        const from = b - step;
        const to = b + step;
        if (seen[from] !== here || wall[to] || occupied[to] || !live[to]) continue;
        occupied[b] = 0;
        occupied[to] = 1;
        const dead = frozenBox(level, goal, to) || frozenBlock(level, occupied, goal, to);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!dead) {
          next = boxes.slice();
          next[bi] = to;
          next.sort((a, b2) => a - b2);
          const low = floodRegion(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
          const prevG = bestG.get(key);
          if (prevG === undefined || cur.g + 1 < prevG) h = heuristic(next);
          else key = -1;
        }
        occupied[to] = 0;
        occupied[b] = 1;
        if (dead || key === -1 || h === Infinity) continue;
        bestG.set(key, cur.g + 1);
        const idx = statesBoxes.length;
        statesBoxes.push(next as number[]);
        statesPlayer.push(b);
        statesKey.push(key);
        parent.push(cur.idx);
        pushDir.push(k);
        pushFrom.push(b);
        heapPush({ f: greedy ? h : cur.g + 1 + h, g: cur.g + 1, seq: seq++, idx });
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    const k = pushDir[s];
    const step = DY[k] * w + DX[k];
    const from = pushFrom[s];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - step);
    for (const b of boxes) occupied[b] = 0;
    moves += STEP[k];
    player = from;
    boxes = nextBoxes.slice();
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box
 * there reaches no goal) out of the floor, and each part left that holds a box is
 * a room. Null when some part holds more or fewer boxes than goals, or a box
 * starts in the hallway: then the level is no set of rooms.
 */
function splitRooms(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DY[k] * w + DX[k];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** One shared pool of work for the whole set, spent room by room. */
const pool = { left: TOTAL_EXPANSIONS };

/**
 * The moves that solve one level, room by room: each room's push-optimal solution
 * in turn, the other rooms' boxes standing as walls (on their goals once their
 * room is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's. An empty
 * string when a room gives up: a valid answer worth no points, but an answer.
 */
function solveLevel(level: Level): string {
  const rooms = splitRooms(level);
  if (rooms === null) {
    const whole = searchPushes(level, ROOM_EXPANSIONS, false, pool);
    if (whole !== null) return whole.moves;
    const greedy = searchPushes(level, FALLBACK_EXPANSIONS, true, pool);
    return greedy === null ? '' : greedy.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = searchPushes(sub, ROOM_EXPANSIONS, false, pool);
    if (solved === null) solved = searchPushes(sub, FALLBACK_EXPANSIONS, true, pool);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
