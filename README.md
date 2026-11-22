[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ichwann12/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ichwann12/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# A push-optimal Sokoban solver, by room decomposition

bounty page: https://make.fun/bounty/sokoban-solver-01-run-20261121

`main.ts` answers every instance of a set in one run: it reads each
`level.txt` under `/input/<id>/`, and writes the player's moves as
`/output/<id>/solution.txt`.

## The idea

make.fun's levels are built from a hallway one square wide with one to
four rooms off it, each room holding 3 or 4 boxes and as many goals, and
a box pushed through a door into the hallway can never be pushed back.
So every box stays in its room, and the level's push-optimal count is
the sum of its rooms' optima. This solver therefore solves each room on
its own, push-optimally, and walks the player through the hallway from
room to room; the total pushes are the level's optimum.

A room is solved with A* over pushes: a state is the boxes and the
player's reachable region, a push costs 1, and the estimate is the
cheapest assignment of the boxes to the goals by their shortest paths,
which never overestimates. Dead squares (no push can ever leave them)
and 2-by-2 blocks of boxes and walls are pruned. The search is cut off
by a fixed number of expansions, never by the clock, so two runs answer
byte for byte the same.

On the kit's practice set it solves all five levels in exactly the
push-optimal count (13, 16, 29, 47, 60 pushes), for the maximum score
of 1,000,000, in about half a second. On 20 further sets drawn fresh
from the kit's generator it scored 1,000,000 on every one.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=../kits/sokoban-solver-01-run-20261121-kit/sokoban-solver-01-run-20261121-kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
