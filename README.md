# eta

A Claude Code mod that shows the work plan as a live task tree with ETAs, in a band above the prompt. The clock is real: the mod measures how long each task took, flags the ones that run past their ceiling, and learns from your history how far off your estimates tend to be.

```
──────────────────────────────────────────────────────────────────────────────
⏱ Migrate the database and ship v2… ✓ 4/16 · ◷ ~17 h left · +1 pending · ✓ ends ~tomorrow 06:40

◷ 1 waiting: Delete old backups (upload confirms)
! Reprocess the 2025 files — stalled? +10 h over
└ ○ Rebuild indexes — 0:30–1:30 h
  └ ○ Build new views — 20–40 min
▶ Import data (2024-01 → today) — ━━━─────  44% · ~14 h (4–24) left
└ ◆ Explore: find where the CSV is read — 3 min
└ ◐ bun run import.ts 2024-01 — 12 min
└ ○ Copy the months to the new server — 10–20 min
✓ Start the collector on the server — took 5 min

? Report format — Option A or B? · then 1–2 h · +1 after
```

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install eta --marketplace rafapolo/ETA
```

Answer `y` to add the marketplace, then pick a scope (user is the first one).

From a shell:

```
claude plugin install eta --marketplace rafapolo/ETA
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `rafapolo/ETA`, then Add plugin.

## What the model gets

The mod registers two tools and tells the model when to call them:

| Tool | What it does |
|---|---|
| `mcp__eta__plan` | Registers the whole plan: a goal and tasks with `min`/`max` minute ranges, `parent` for dependencies, and an optional `status`. Calling it again replaces the plan; tasks with the same id or title keep their measured times. The answer is the plan as text plus the calibration factor. |
| `mcp__eta__task` | Updates one task: `running` when it starts, `done` when it ends, a new `min`/`max` to re-estimate, `waitingOn` for what it waits on or the question it asks. |

## Symbols and colors

Every symbol takes one column, so titles line up; color tells the statuses apart. Colors come from the Claude Code theme, so they follow light and dark themes.

| Symbol | Status | Color | When |
|---|---|---|---|
| `▶` | running | green (`success`) | the model marked the task `running` |
| `◆` | subagent running | orange (`claude`) | the model called the `Agent` tool |
| `◐` | background process | cyan (`planMode`) | the model ran `Bash` with `run_in_background` |
| `○` | queued | yellow (`warning`), dimmed text | not started yet |
| `◷` | waiting | magenta (`permission`) | waits on something outside: another session, a download, CI |
| `?` | question | bold blue (`suggestion`) | waits on an answer from you; sits below the tree |
| `✕` | blocked | red (`error`) | cannot go on; for a subagent or process, `failed` or `killed` |
| `!` | overdue | yellow (`warning`) | went past the top of its range |
| `✓` | done | green (`success`), dimmed text | finished; shows how long it took |

The first line, in gray, after the goal in bold:

| Part | Says |
|---|---|
| `✓ 4/16` | tasks done out of the total |
| `◷ ~17 h left` | the likely time left: the midpoint of the remaining range |
| `+1 pending` | questions waiting on you, not counted in the time left |
| `+2 unestimated` | tasks with no range yet (mirrored from `TodoWrite` or `TaskCreate`) |
| `✓ ends ~23:02` | the local end time at the likely value: just the time for today, `tomorrow 06:40`, or `Oct 31 09:00` |

On a task's row:

| Part | Color | Says |
|---|---|---|
| `━━━─────  44%` | blue, empty part dimmed | progress over the range's midpoint, up to 99% |
| `~14 h (4–24) left` / `up to 3 min left` | blue | what is left; a wide range shows its midpoint first; past the minimum, only the ceiling |
| `+2 min over` | yellow | how far past the ceiling |
| `stalled? +10 h over` | yellow | the overrun passed 30 min and the task's own ceiling: most likely it was never closed |
| `· +N after` | dimmed | tasks that depend on this one and are not shown |

## How the mod learns about tasks

The mod does not watch the work itself: it listens to tool calls.

| Source | Joins the tree | Changes or leaves |
|---|---|---|
| `mcp__eta__plan` | the whole plan, with ranges and dependencies | a new plan replaces the old one |
| `mcp__eta__task` | — | changes the status: `running` stamps the start, `done` the end |
| `TodoWrite` | a new title becomes an unestimated task at the root | `pending` → `○`, `in_progress` → `▶`, `completed` → `✓`; dropped from the list, it leaves the tree |
| `TaskCreate` / `TaskUpdate` | the created task; the first `addBlockedBy` becomes its parent | status changes; `deleted` removes it |
| `Agent` (subagent) | `◆ type: description`, a child of the only `▶` task when there is exactly one | the agent list says `completed`, `failed` or `killed` (checked every minute and after each of the subagent's turns) |
| `Bash` with `run_in_background` | `◐ description or command`, a child of the only `▶` task | the process's finish notice arrives in the transcript |

On load (a new session or a reload of the mod), subagents already running join the tree, timed from that moment. Background processes started before the mod loaded do not show: there is no list of them to read.

Finished subagents and processes stay for 5 minutes as `✓ took X` (or `✕ failed`), then leave the tree. They have no estimate, so they count neither in the time left nor as unestimated.

## Reading the tree

- `└` indented under a task's icon = depends on it: it starts only when that task is done.
- Tasks at the same indent are independent of each other.
- **Questions** sit in their own section, after a blank line below the tree, together with what depends on them. Once answered, the task returns to its place in the tree.
- The `◷ N waiting` line right below the first line gathers the outside waits.

## How time is counted

- Ranges are in wall-clock minutes, from a task's start to its end.
- **Time left:** only running tasks run together, and of those the longest counts; the rest of the queue adds up in series, since an agent does one thing at a time. Subagents and processes are measured parallelism but carry no estimate, so they only show in the tree. Questions do not count until answered: they show as `+N pending`.
- **Calibration:** each estimated task that finishes becomes a sample (estimate × actual). From 5 samples on, the answer of `mcp__eta__plan` carries the median factor, and the model scales its next ranges by it. The history keeps the last 200 samples, across sessions.
- The band redraws on its own every minute without calling the model: the tick costs no tokens. Only the `mcp__eta__plan` and `mcp__eta__task` calls go to the model.

## The `/eta` command

Type `/eta` at the prompt to hide the band; type it again to show it. The answer says which: `ETA: band hidden.` or `ETA: band shown.`

- Hiding only hides: the plan, the times and the calibration keep being recorded, and the band comes back up to date.
- It applies to the session it was typed in; other sessions and new ones start with the band shown.
- It changes no setting and no file of the mod.
- Without `/eta`, the band already hides itself when there is no plan, when every task is done, and while Claude Code shows a survey above the prompt.

## Upgrading from 0.1

Version 0.2 renamed the tools (`mcp__eta__plano` → `mcp__eta__plan`, `mcp__eta__tarefa` → `mcp__eta__task`) and their fields to English. A session that ran 0.1 keeps its plan and calibration history: the mod migrates both on load.

## Develop

```
claude --plugin-dir .          # a session with the mod loaded from this folder
claude plugin validate .
claude plugin test .
```
