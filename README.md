# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/zavonlame/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/zavonlame/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: one program answers a whole set of five levels in a single run, in as few pushes as possible.

## How it works

Every generated level is one hallway with small rooms off it, and a box pushed out of a room through its door can never come back — so each room is an independent problem. The solver splits a level into its rooms (cutting the hallway's dead squares out of the floor), solves each room push-optimally, and stitches the rooms together with shortest player walks along the hallway.

Each room is solved with A* over pushes: a state is the boxes' squares plus the player's reachable region, ordered by pushes made plus an admissible heuristic — the cheapest assignment of boxes to goals by push-distance. Dead states are pruned with live squares (a box that can never be pushed onto a goal), frozen boxes, and frozen 2x2 blocks. If A* runs out of its work budget, a greedy best-first pass tries for any solution at all, since a solved level at more pushes still scores while an unsolved one scores nothing.

The solver is deterministic by construction: one fixed direction order, fixed tie-breaks, and a work budget counted in state expansions — never the clock, never randomness.

On the practice set it scores **1,000,000** (every instance push-optimal: 13, 16, 29, 47 and 60 pushes), against the house baseline's 200,000. The whole set solves in about a third of a second.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads each `<id>/level.txt` under the input dir and writes `<id>/solution.txt` under the output dir, creating the directories itself. Node 22, standard library only, no network. `practice/input` is the kit's practice set; the grader supplies its own input dir the same way.

To check the score locally from the unpacked kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --worktree --driver process
```

<sub>Entered on [make.fun](https://make.fun/?ref=ye09dzcs&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
