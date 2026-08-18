// Board shaping for the Objectives surface. The date math gets the scrutiny:
// "overdue" is an accountability word, and a task flagged overdue on its own
// due day teaches the team to ignore the flag.

import { describe, expect, it } from "vitest";
import type { PlannerBoard, PlannerTaskDetail } from "../src/gatekeepers/graph";
import {
  boardOrder,
  bucketNames,
  calendarDaysUntil,
  dueLabel,
  groupByBucket,
  isOverdue,
  priorityLabel,
  rollup,
  taskState,
} from "../src/lib/planner";

const NOW = new Date("2026-08-18T15:30:00Z");

const task = (over: Partial<PlannerTaskDetail> = {}): PlannerTaskDetail => ({
  id: over.id ?? "t1",
  title: "Ship the thing",
  bucketId: "b1",
  percentComplete: 0,
  priority: 5,
  createdDateTime: "2026-08-01T00:00:00Z",
  dueDateTime: null,
  completedDateTime: null,
  assigneeIds: [],
  ...over,
});

describe("taskState", () => {
  it("maps Planner's three states", () => {
    expect(taskState(task({ percentComplete: 0 }))).toBe("not_started");
    expect(taskState(task({ percentComplete: 50 }))).toBe("in_progress");
    expect(taskState(task({ percentComplete: 100 }))).toBe("done");
  });
});

describe("isOverdue", () => {
  it("is not overdue on the due day itself — the day has to end first", () => {
    // Planner writes due dates as midnight UTC; by 15:30 the instant has
    // passed but the day has not.
    expect(isOverdue(task({ dueDateTime: "2026-08-18T00:00:00Z" }), NOW)).toBe(false);
    expect(isOverdue(task({ dueDateTime: "2026-08-17T00:00:00Z" }), NOW)).toBe(true);
    expect(isOverdue(task({ dueDateTime: "2026-08-19T00:00:00Z" }), NOW)).toBe(false);
  });

  it("never marks a done or undated task overdue", () => {
    expect(isOverdue(task({ dueDateTime: "2026-08-01T00:00:00Z", percentComplete: 100 }), NOW)).toBe(false);
    expect(isOverdue(task({ dueDateTime: null }), NOW)).toBe(false);
  });
});

describe("calendarDaysUntil", () => {
  it("counts calendar days, not 24-hour windows", () => {
    expect(calendarDaysUntil(new Date("2026-08-18T23:59:00Z"), new Date("2026-08-19T00:01:00Z"))).toBe(1);
    expect(calendarDaysUntil(NOW, new Date("2026-08-18T00:00:00Z"))).toBe(0);
    expect(calendarDaysUntil(NOW, new Date("2026-08-15T00:00:00Z"))).toBe(-3);
  });
});

describe("dueLabel", () => {
  it("always carries its unit and direction", () => {
    expect(dueLabel(task({ dueDateTime: "2026-08-15T00:00:00Z" }), NOW)).toBe("3 days overdue");
    expect(dueLabel(task({ dueDateTime: "2026-08-17T00:00:00Z" }), NOW)).toBe("1 day overdue");
    expect(dueLabel(task({ dueDateTime: "2026-08-18T00:00:00Z" }), NOW)).toBe("due today");
    expect(dueLabel(task({ dueDateTime: "2026-08-19T00:00:00Z" }), NOW)).toBe("due tomorrow");
    expect(dueLabel(task({ dueDateTime: "2026-08-25T00:00:00Z" }), NOW)).toBe("due in 7 days");
    expect(dueLabel(task({ dueDateTime: "2026-10-01T00:00:00Z" }), NOW)).toBe("due 2026-10-01");
    expect(dueLabel(task(), NOW)).toBe("no due date");
  });
});

describe("priorityLabel", () => {
  it("labels only the bands that ask for attention", () => {
    expect(priorityLabel(1)).toBe("urgent");
    expect(priorityLabel(3)).toBe("important");
    expect(priorityLabel(5)).toBeUndefined(); // medium — the default, so it is noise
    expect(priorityLabel(9)).toBeUndefined(); // low — a whisper
  });
});

describe("rollup", () => {
  const tasks = [
    task({ id: "a", assigneeIds: ["me"], dueDateTime: "2026-08-10T00:00:00Z" }), // mine, overdue
    task({ id: "b", assigneeIds: ["someone-else"], percentComplete: 50 }),
    task({ id: "c", assigneeIds: [] }), // unassigned
    task({ id: "d", assigneeIds: ["me"], percentComplete: 100 }), // done — not "mine open"
  ];

  it("counts open, done, overdue, unassigned and mine", () => {
    expect(rollup(tasks, NOW, "me")).toEqual({
      total: 4,
      open: 3,
      done: 1,
      overdue: 1,
      unassigned: 1,
      mine: 1,
    });
  });

  it("reports mine as zero when the viewer's id is unknown, never a guess", () => {
    expect(rollup(tasks, NOW).mine).toBe(0);
  });
});

describe("boardOrder", () => {
  it("reads overdue first, then dated by due date, undated last oldest-first", () => {
    const overdue = task({ id: "over", dueDateTime: "2026-08-10T00:00:00Z" });
    const soon = task({ id: "soon", dueDateTime: "2026-08-20T00:00:00Z" });
    const later = task({ id: "later", dueDateTime: "2026-09-20T00:00:00Z" });
    const oldUndated = task({ id: "old", createdDateTime: "2026-07-01T00:00:00Z" });
    const newUndated = task({ id: "new", createdDateTime: "2026-08-17T00:00:00Z" });
    const sorted = [newUndated, later, oldUndated, soon, overdue].sort((a, b) => boardOrder(a, b, NOW));
    expect(sorted.map((t) => t.id)).toEqual(["over", "soon", "later", "old", "new"]);
  });
});

describe("groupByBucket", () => {
  const board: PlannerBoard = {
    buckets: [
      { id: "b1", name: "In progress" },
      { id: "b2", name: "Backlog" },
      { id: "b3", name: "Empty" },
    ],
    tasks: [
      task({ id: "t1", bucketId: "b2" }),
      task({ id: "t2", bucketId: "b1" }),
      task({ id: "t3", bucketId: "gone" }), // bucket deleted in Planner
      task({ id: "t4", bucketId: "b1", percentComplete: 100 }), // done — off the board
    ],
  };

  it("keeps the plan's bucket order, drops empty buckets, and never loses an orphan", () => {
    const groups = groupByBucket(board, NOW);
    expect(groups.map((g) => g.name)).toEqual(["In progress", "Backlog", "(no bucket)"]);
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["t2"]);
    expect(groups[2]?.tasks.map((t) => t.id)).toEqual(["t3"]);
    const shown = groups.flatMap((g) => g.tasks.map((t) => t.id));
    expect(shown.sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("maps bucket ids to names for rendering a task outside its board", () => {
    expect(bucketNames(board).get("b2")).toBe("Backlog");
  });
});
