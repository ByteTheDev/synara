// Performance-panel style summary of a trace: main-thread self time per category for
// each user step (bounded by performance.mark("step:<name>:start|end")).
// usage: node analyze-trace.mjs <trace.json>
import { readFileSync } from "node:fs";

const { traceEvents: events } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const CATEGORY = [
  [
    "scripting",
    /^(FunctionCall|EvaluateScript|v8\.|V8\.|TimerFire|FireAnimationFrame|RunMicrotasks|EventDispatch|FireIdleCallback|MinorGC|MajorGC|BlinkGC|GCEvent|XHRReadyStateChange|XHRLoad|ParseHTML|ParseAuthorStyleSheet)/,
  ],
  [
    "rendering",
    /^(UpdateLayoutTree|Layout|RecalculateStyles|HitTest|PrePaint|Layerize|ScheduleStyleRecalculation|InvalidateLayout|IntersectionObserver|ResizeObserver|UpdateLayer|ScrollLayer|LayoutShift)/,
  ],
  [
    "painting",
    /^(Paint|PaintImage|CompositeLayers|Commit|Decode|Rasterize|ImageDecodeTask|DrawLazyPixelRef|GPUTask)/,
  ],
];
const categoryOf = (name) => CATEGORY.find(([, re]) => re.test(name))?.[0] ?? "other";

// The page's renderer main thread is the busiest CrRendererMain.
const mains = events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
const busy = (m) =>
  events
    .filter((e) => e.pid === m.pid && e.tid === m.tid && e.name === "RunTask")
    .reduce((s, e) => s + (e.dur ?? 0), 0);
const main = mains.sort((a, b) => busy(b) - busy(a))[0];
const onMain = events
  .filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === "X" && e.dur)
  .sort((a, b) => a.ts - b.ts || b.dur - a.dur);

// Self time via a containment stack.
const self = [];
const stack = [];
for (const e of onMain) {
  while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
  const parent = stack.at(-1);
  const item = { ts: e.ts, end: e.ts + e.dur, name: e.name, self: e.dur };
  if (parent) parent.item.self -= e.dur;
  self.push(item);
  stack.push({ ts: e.ts, dur: e.dur, item });
}

const marks = events.filter((e) => e.cat?.includes("blink.user_timing") && /^step:/.test(e.name));
const steps = new Map();
for (const mark of marks) {
  const [, kind, chat, edge] = mark.name.split(":");
  const key = `${kind}:${chat}`;
  const entry = steps.get(key) ?? {};
  entry[edge] ??= mark.ts;
  steps.set(key, entry);
}
const summarize = (from, to) => {
  const out = { scripting: 0, rendering: 0, painting: 0, other: 0 };
  for (const item of self) {
    if (item.ts < from || item.ts >= to || item.name === "RunTask") continue;
    out[categoryOf(item.name)] += item.self / 1000;
  }
  const tasks = onMain.filter((e) => e.name === "RunTask" && e.ts >= from && e.ts < to);
  return {
    ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v)])),
    busy: Math.round(tasks.reduce((s, e) => s + e.dur, 0) / 1000),
    longTasks: tasks.filter((e) => e.dur > 50_000).length,
    maxTask: Math.round(Math.max(0, ...tasks.map((e) => e.dur)) / 1000),
    styleRecalcs500: onMain.filter(
      (e) =>
        e.name === "UpdateLayoutTree" &&
        e.ts >= from &&
        e.ts < to &&
        (e.args?.elementCount ?? 0) > 500,
    ).length,
  };
};
const result = {};
for (const [key, { start, end }] of steps) if (start && end) result[key] = summarize(start, end);
console.log(JSON.stringify(result));
