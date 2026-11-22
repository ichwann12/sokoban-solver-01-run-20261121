// A push-optimal Sokoban solver, by room decomposition.
//
// make.fun's levels are built from a hallway one square wide with one to
// four rooms off it, each room holding 3 or 4 boxes and as many goals, and
// a box pushed through a door into the hallway can never be pushed back.
// So every box stays in its room, and the level's push-optimal count is
// the sum of its rooms' optima. This solver therefore solves each room
// on its own, push-optimally, and walks the player through the hallway
// from room to room; the total pushes are the level's optimum.
//
// A room is solved with A* over pushes (Hart, Nilsson and Raphael,
// 1968): a state is the boxes and the player's reachable region, a push
// costs 1, and the estimate is the cheapest assignment of the boxes to
// the goals by the boxes' shortest paths, which never overestimates.
// Dead squares (no path to any goal) and 2-by-2 blocks of boxes and
// walls are pruned. The search is cut off by a fixed number of
// expansions, never by the clock, so two runs answer byte for byte the
// same; the rooms in these levels are small (at most 6 by 6, 4 boxes)
// and the search finishes far inside that budget.
//
// The moves are the player's steps in LURD (u, d, l, r): the walk to
// each push, the push itself, the walk out of the room, and the walk
// through the hallway to the next room's door.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** A fixed expansion budget per room: the search never reads the clock. */
const EXPANSIONS = 2_000_000;

/** The four steps, in a fixed order so every path this program finds is the same on every run. */
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** A level's text (XSB) read into walls, goals, boxes and the player. */
function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = 1;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  return { w, h, wall, goals, boxes, player };
}

type Room = {
  /** The room's floor, as level cells: the component plus the entry cell in the hallway. */
  cells: number[];
  /** The door: the room cell the hallway opens onto. */
  door: number;
  /** The hallway cell beside the door, where the player stands to enter. */
  entry: number;
  boxes: number[];
  goals: number[];
};

/**
 * The rooms of a level: the player starts in the hallway, so the hallway
 * row is that of '@'; the floor off that row falls into connected
 * components, each one room, and each room touches the hallway through
 * one door cell.
 */
function findRooms(level: Level): Room[] {
  const { w, h, wall, goals, boxes, player } = level;
  const hallRow = Math.floor(player / w);
  const goalSet = new Set(goals);
  const boxSet = new Set(boxes);
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  const at = (x: number, y: number): number => y * w + x;
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || seen[i]) continue;
    if (Math.floor(i / w) === hallRow) continue;
    const cells: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const c = stack.pop()!;
      cells.push(c);
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = at(nx, ny);
        if (wall[n] || seen[n] || Math.floor(n / w) === hallRow) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    // The door: a cell of the component beside a hallway floor cell.
    let door = -1;
    let entry = -1;
    for (const c of cells) {
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (ny !== hallRow || nx < 0 || nx >= w) continue;
        const n = at(nx, ny);
        if (!wall[n]) {
          door = c;
          entry = n;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) continue;
    const roomBoxes = cells.filter((c) => boxSet.has(c));
    const roomGoals = cells.filter((c) => goalSet.has(c));
    // The entry cell is floor the player stands on; it belongs to the room's search.
    rooms.push({ cells: [...cells, entry], door, entry, boxes: roomBoxes, goals: roomGoals });
  }
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

/** A binary heap on [f, g, counter, node], smallest f first, deeper g then earlier counter on a tie. */
class Heap {
  a: [number, number, number, number][] = [];
  less(x: [number, number, number, number], y: [number, number, number, number]): boolean {
    return x[0] < y[0] || (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] < y[2])));
  }
  push(e: [number, number, number, number]): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && this.less(a[c + 1]!, a[c]!)) c++;
        if (!this.less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
  get size(): number {
    return this.a.length;
  }
}

/**
 * One room, solved push-optimally from its entry cell.
 * Returns the player's moves from the entry cell to the door cell, the
 * room solved, or '' when the search gives up (the caller then leaves
 * the room unsolved rather than writing an illegal move).
 */
function solveRoom(room: Room, w: number): string {
  const cells = room.cells;
  const m = cells.length;
  const idx = new Map<number, number>();
  cells.forEach((c, i) => idx.set(c, i));
  const door = idx.get(room.door)!;
  const start = idx.get(room.entry)!;
  const goalMask = room.goals.reduce((a, c) => a | (1 << idx.get(c)!), 0);
  const goals = room.goals.map((c) => idx.get(c)!);
  let boxesMask = room.boxes.reduce((a, c) => a | (1 << idx.get(c)!), 0);
  // Neighbours of each cell of the room, as a bitmask over the room's cells.
  const nb: number[] = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    const c = cells[i]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    let mask = 0;
    for (let d = 0; d < 4; d++) {
      const n = idx.get((cy + DIRS[d]!.dy) * w + (cx + DIRS[d]!.dx));
      if (n !== undefined) mask |= 1 << n;
    }
    nb[i] = mask;
  }
  // The 2-by-2 squares each cell belongs to, as bitmasks over the room's
  // cells: a square whose cells are all walls or boxes, holding a box off
  // a goal, is a deadlock. A cell outside the room, or off the board, is
  // a wall and blocks the square.
  const squares: number[][] = Array.from({ length: m }, () => []);
  const cellXY = cells.map((c) => [c % w, Math.floor(c / w)] as const);
  for (let i = 0; i < m; i++) {
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      const x0 = cellXY[i]![0] + dx;
      const y0 = cellXY[i]![1] + dy;
      let mask = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const x = x0 + sx;
          const y = y0 + sy;
          if (x < 0 || x >= w || y < 0) continue;
          const j = idx.get(y * w + x);
          if (j !== undefined) mask |= 1 << j;
        }
      }
      // A square counts only when it holds this cell and at least one
      // other room cell; a lone cell against walls is no 2-by-2 block.
      if (mask !== 0 && (mask & ~(1 << i)) !== 0) squares[i]!.push(mask);
    }
  }
  // The squares a box can ever leave, by static analysis: a square is
  // live when it is a goal, or when a box on it can be pushed onto a
  // live square with the player standing on open floor behind it. The
  // entry cell is not live (the player can never stand past it, in the
  // hallway), so a box pushed onto it and off its goal is stuck.
  const live = new Set<number>(goals);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < m; i++) {
      if (live.has(i)) continue;
      const [cx, cy] = cellXY[i]!;
      for (let d = 0; d < 4; d++) {
        const ahead = idx.get((cy + DIRS[d]!.dy) * w + (cx + DIRS[d]!.dx));
        const behind = idx.get((cy - DIRS[d]!.dy) * w + (cx - DIRS[d]!.dx));
        if (ahead !== undefined && behind !== undefined && live.has(ahead)) {
          live.add(i);
          changed = true;
          break;
        }
      }
    }
  }
  const deadMask = cells.reduce((a, _c, i) => (live.has(i) ? a : a | (1 << i)), 0);
  // Shortest paths, box to goal, over the room's floor and ignoring the
  // other boxes: dist[goal cell][cell]. Infinity where no path runs.
  const dist: (number[] | undefined)[] = new Array(m);
  for (const g of goals) {
    const d = new Array<number>(m).fill(Infinity);
    const q = [g];
    d[g] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      let bits = nb[c]!;
      while (bits) {
        const n = 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        if (d[n]! === Infinity) {
          d[n] = d[c]! + 1;
          q.push(n);
        }
      }
    }
    dist[g] = d;
  }
  const bitList = (mask: number): number[] => {
    const out: number[] = [];
    let b = mask;
    while (b) {
      const lsb = b & -b;
      out.push(31 - Math.clz32(lsb));
      b &= b - 1;
    }
    return out;
  };
  // The cheapest assignment of the boxes to the goals, over every
  // permutation; Infinity when a box reaches no goal. Memoised on the
  // boxes, which many states share.
  const hMemo = new Map<number, number>();
  const heuristic = (mask: number): number => {
    const got = hMemo.get(mask);
    if (got !== undefined) return got;
    const bs = bitList(mask);
    let best = Infinity;
    const perm = goals.slice();
    const tryPerm = (k: number): void => {
      if (k === bs.length) {
        let s = 0;
        for (let i = 0; i < bs.length; i++) {
          const d = dist[perm[i]!]![bs[i]!]!;
          if (d === Infinity) return;
          s += d;
        }
        if (s < best) best = s;
        return;
      }
      for (let i = k; i < perm.length; i++) {
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        tryPerm(k + 1);
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      }
    };
    tryPerm(0);
    hMemo.set(mask, best);
    return best;
  };
  // The player's reachable region from a cell, over the room's floor
  // with the boxes as walls. Memoised on the boxes and the cell.
  const regionMemo = new Map<number, number>();
  const region = (mask: number, from: number): number => {
    const key = mask * 64 + from;
    const got = regionMemo.get(key);
    if (got !== undefined) return got;
    let seen = 1 << from;
    let frontier = seen;
    while (frontier) {
      let next = 0;
      let b = frontier;
      while (b) {
        const lsb = b & -b;
        next |= nb[31 - Math.clz32(lsb)]!;
        b &= b - 1;
      }
      next &= ~seen & ~mask;
      seen |= next;
      frontier = next;
    }
    regionMemo.set(key, seen);
    return seen;
  };
  // A*: nodes in arrays, the heap on f, the visited map on the boxes and
  // the player's region (its lowest cell), so two players standing in
  // the same reachable region are one state.
  const nBoxes: number[] = [boxesMask];
  const nPlayer: number[] = [start];
  const nG: number[] = [0];
  const nParent: number[] = [-1];
  const nPushBox: number[] = [-1];
  const nPushDir: number[] = [-1];
  const best = new Map<number, number>();
  const canon = (mask: number, p: number): number => {
    const r = region(mask, p);
    return 31 - Math.clz32(r & -r);
  };
  best.set(boxesMask * 64 + canon(boxesMask, start), 0);
  const heap = new Heap();
  let counter = 0;
  heap.push([heuristic(boxesMask), 0, counter++, 0]);
  let expanded = 0;
  let goalNode = -1;
  while (heap.size > 0 && expanded < EXPANSIONS) {
    const [, g, , s] = heap.pop();
    const mask = nBoxes[s]!;
    const p = nPlayer[s]!;
    if (best.get(mask * 64 + canon(mask, p)) !== s) continue;
    const r = region(mask, p);
    if ((mask & ~goalMask) === 0 && (r & (1 << door)) !== 0) {
      goalNode = s;
      break;
    }
    expanded++;
    // Every push: a box with the player behind it and open floor ahead.
    for (const b of bitList(mask)) {
      const bx = cellXY[b]![0];
      const by = cellXY[b]![1];
      for (let d = 0; d < 4; d++) {
        const from = idx.get((by - DIRS[d]!.dy) * w + (bx - DIRS[d]!.dx));
        const to = idx.get((by + DIRS[d]!.dy) * w + (bx + DIRS[d]!.dx));
        if (from === undefined || to === undefined) continue;
        if ((r & (1 << from)) === 0) continue;
        if ((mask & (1 << to)) !== 0) continue;
        const nm = (mask & ~(1 << b)) | (1 << to);
        // A box on a square no push can ever leave is stuck for good.
        if ((nm & deadMask) !== 0) continue;
        // Deadlock: a 2-by-2 block of boxes and walls holding a box off a goal.
        let dead = false;
        for (const sq of squares[to]!) {
          if ((sq & ~nm) === 0 && (sq & nm & ~goalMask) !== 0) {
            dead = true;
            break;
          }
        }
        if (dead) continue;
        const h = heuristic(nm);
        if (h === Infinity) continue;
        const t = nBoxes.length;
        const key = nm * 64 + canon(nm, b);
        const seenNode = best.get(key);
        if (seenNode !== undefined && nG[seenNode]! <= g + 1) continue;
        nBoxes.push(nm);
        nPlayer.push(b);
        nG.push(g + 1);
        nParent.push(s);
        nPushBox.push(b);
        nPushDir.push(d);
        best.set(key, t);
        heap.push([g + 1 + h, g + 1, counter++, t]);
      }
    }
  }
  if (goalNode < 0) return '';
  // Rebuild the pushes, then walk them out: the walk to each push, the
  // push itself, and the walk to the door.
  const pushes: [number, number][] = [];
  for (let t = goalNode; t > 0; t = nParent[t]!) pushes.push([nPushBox[t]!, nPushDir[t]!]);
  pushes.reverse();
  const walk = (from: number, to: number, mask: number): string | null => {
    if (from === to) return '';
    const prev = new Int32Array(m).fill(-2);
    const prevDir = new Int8Array(m).fill(-1);
    prev[from] = -1;
    const q = [from];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      for (let d = 0; d < 4; d++) {
        const n = idx.get((cellXY[c]![1] + DIRS[d]!.dy) * w + (cellXY[c]![0] + DIRS[d]!.dx));
        if (n === undefined || prev[n] !== -2 || (mask & (1 << n)) !== 0) continue;
        prev[n] = c;
        prevDir[n] = d;
        if (n === to) {
          let moves = '';
          for (let t = n; t !== from; t = prev[t]!) moves = DIRS[prevDir[t]!]!.ch + moves;
          return moves;
        }
        q.push(n);
      }
    }
    return null;
  };
  let moves = '';
  let player = start;
  let curMask = boxesMask;
  for (const [b, d] of pushes) {
    const from = idx.get((cellXY[b]![1] - DIRS[d]!.dy) * w + (cellXY[b]![0] - DIRS[d]!.dx))!;
    const w1 = walk(player, from, curMask);
    if (w1 === null) return '';
    moves += w1;
    moves += DIRS[d]!.ch;
    curMask = (curMask & ~(1 << b)) | (1 << idx.get((cellXY[b]![1] + DIRS[d]!.dy) * w + (cellXY[b]![0] + DIRS[d]!.dx))!);
    player = b;
  }
  const w2 = walk(player, door, curMask);
  if (w2 === null) return '';
  moves += w2;
  return moves;
}

/** The player's walk on the hallway row, from one cell to another. */
function hallWalk(level: Level, from: number, to: number): string {
  const { w, h, wall } = level;
  const hallRow = Math.floor(from / w);
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-2);
  const prevDir = new Int8Array(w * h).fill(-1);
  prev[from] = -1;
  const q = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d]!.dx;
      const ny = cy + DIRS[d]!.dy;
      if (ny !== hallRow || nx < 0 || nx >= w) continue;
      const n = ny * w + nx;
      if (wall[n] || prev[n] !== -2) continue;
      prev[n] = c;
      prevDir[n] = d;
      if (n === to) {
        let moves = '';
        for (let t = n; t !== from; t = prev[t]!) moves = DIRS[prevDir[t]!]!.ch + moves;
        return moves;
      }
      q.push(n);
    }
  }
  return '';
}

/** One level's moves: walk the hallway, solve each room, walk on. */
function solve(text: string): string {
  const level = parse(text);
  const rooms = findRooms(level);
  let moves = '';
  let player = level.player;
  for (const room of rooms) {
    moves += hallWalk(level, player, room.entry);
    player = room.entry;
    const roomMoves = solveRoom(room, level.w);
    if (roomMoves === '') return '';
    moves += roomMoves;
    // Step out of the door into the hallway.
    const dx = room.entry % level.w - (room.door % level.w);
    const dy = Math.floor(room.entry / level.w) - Math.floor(room.door / level.w);
    const d = DIRS.findIndex((dd) => dd.dx === dx && dd.dy === dy);
    moves += DIRS[d]!.ch;
    player = room.entry;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
