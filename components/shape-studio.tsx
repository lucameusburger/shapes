"use client";

import { startTransition, useMemo, useState } from "react";

const DEFAULT_GRID = 6;
const DEFAULT_RADIUS = 28;
const DEFAULT_GAP = 18;

const MIN_GRID = 2;
const MAX_GRID = 12;
const MIN_RADIUS = 10;
const MAX_RADIUS = 56;
const MIN_GAP = 0;
const MAX_GAP = 60;

const BACKGROUND = "#2f3230";

type Point = { x: number; y: number };

type Circle = Point & {
  index: number;
  row: number;
  col: number;
  on: boolean; // true = white = inside the shape
};

type Winding = 1 | -1; // +1 CCW visually (white), -1 CW visually (black)

type Segment = {
  from: Circle;
  to: Circle;
  wFrom: Winding;
  wTo: Winding;
  // Tangent endpoints: where the path leaves `from` and arrives at `to`.
  pFrom: Point;
  pTo: Point;
};

type Model = {
  circles: Circle[];
  pathData: string;
  size: number;
  svgMarkup: string;
};

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function fmt(n: number) {
  return Number.isFinite(n) ? n.toFixed(3) : "0";
}

function normalizeSeed(seed: number) {
  if (!Number.isFinite(seed)) return 1;
  const s = Math.floor(seed) % 2147483647;
  return s <= 0 ? s + 2147483646 : s;
}

function createRng(seed: number) {
  let state = normalizeSeed(seed);
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function randomStates(count: number, seed: number): boolean[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng() > 0.5);
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

// Serpentine (boustrophedon) row order. Even rows go left-to-right, odd rows
// right-to-left. Adjacent visits are always 1 cell apart, and on an even grid
// the closing tangent runs cleanly down the left edge instead of cutting
// across the interior.
function serpentineOrder(size: number): number[] {
  const order: number[] = [];
  for (let row = 0; row < size; row += 1) {
    if (row % 2 === 0) {
      for (let col = 0; col < size; col += 1) order.push(row * size + col);
    } else {
      for (let col = size - 1; col >= 0; col -= 1) order.push(row * size + col);
    }
  }
  return order;
}

/**
 * Compute the tangent endpoints between two equal-radius circles, treating
 * each circle as having a winding direction (CCW for white, CW for black).
 *
 * Geometry (SVG coordinates, +x right, +y down):
 *   u = unit vector A → B
 *   v = u rotated +90° in SVG = (-u.y, u.x) (visually clockwise)
 *   sin β = (wTo - wFrom) · r / d
 *   tangent point on X = X + r · w_X · (−sin β · u + cos β · v)
 *
 * Same colour ⇒ sin β = 0, cos β = 1: external tangent on the v-side of motion.
 * Opposite colour ⇒ |sin β| = 2r/d: internal tangent that crosses between them.
 */
function computeSegment(
  from: Circle,
  to: Circle,
  wFrom: Winding,
  wTo: Winding,
  r: number,
  flip: boolean,
): Segment {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    return {
      from,
      to,
      wFrom,
      wTo,
      pFrom: { x: from.x, y: from.y },
      pTo: { x: to.x, y: to.y },
    };
  }
  const ux = dx / d;
  const uy = dy / d;
  const vx = -uy;
  const vy = ux;

  let sinB = ((wTo - wFrom) * r) / d;
  if (sinB > 1) sinB = 1;
  if (sinB < -1) sinB = -1;
  const cosBmag = Math.sqrt(Math.max(0, 1 - sinB * sinB));
  // Flip toggles the cos β sign — i.e. picks the OTHER of the two tangents
  // (mirrored across the line of centers). For same-colour pairs this swaps
  // between the two outer tangents; for opposite-colour pairs it swaps
  // between the two inner tangents.
  const cosB = flip ? -cosBmag : cosBmag;

  const nx = -sinB * ux + cosB * vx;
  const ny = -sinB * uy + cosB * vy;

  return {
    from,
    to,
    wFrom,
    wTo,
    pFrom: { x: from.x + r * wFrom * nx, y: from.y + r * wFrom * ny },
    pTo: { x: to.x + r * wTo * nx, y: to.y + r * wTo * ny },
  };
}

/**
 * Build an SVG arc command that traces the circle from `entry` to `exit`
 * in the direction implied by the winding `w`.
 *
 * In SVG coordinates (+y down), increasing the polar angle moves the point
 * clockwise visually. So:
 *   w = +1 (CCW visually) ⇒ polar angle decreases ⇒ sweep flag 0.
 *   w = -1 (CW visually)  ⇒ polar angle increases ⇒ sweep flag 1.
 */
function buildArcCommand(
  circle: Circle,
  entry: Point,
  exit: Point,
  w: Winding,
  r: number,
): string {
  const entryAngle = Math.atan2(entry.y - circle.y, entry.x - circle.x);
  const exitAngle = Math.atan2(exit.y - circle.y, exit.x - circle.x);
  const TAU = Math.PI * 2;
  let delta = exitAngle - entryAngle;
  if (w === 1) {
    while (delta > 0) delta -= TAU;
    while (delta < -TAU) delta += TAU;
  } else {
    while (delta < 0) delta += TAU;
    while (delta > TAU) delta -= TAU;
  }
  const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
  const sweep = w === -1 ? 1 : 0;
  return `A ${fmt(r)} ${fmt(r)} 0 ${largeArc} ${sweep} ${fmt(exit.x)} ${fmt(exit.y)}`;
}

/**
 * Build a single non‑self‑intersecting closed loop ("rubber band") that
 * encloses every white circle and excludes every black circle.
 *
 * Strategy:
 *   1. Traverse the whites in convex‑hull order (CCW visually). The hull
 *      gives the outer perimeter — interior whites are automatically
 *      enclosed and don't need to appear on the boundary.
 *   2. For each consecutive hull pair, draw the outer tangent on the
 *      OUTSIDE of the hull (right of motion in SVG = left of motion
 *      visually, since +y is down).
 *   3. If that outer tangent clips into any black disc, detour: tangent
 *      to the black (inner tangent), arc the wrong way around the black
 *      (so it stays OUTSIDE the loop), tangent away from the black to
 *      the next white. Multiple blocking blacks along one segment are
 *      handled in projection order.
 *   4. At each white, arc around the inside of the disc connecting the
 *      incoming and outgoing tangent points (so the white stays inside
 *      the loop).
 */
function buildPath(circles: Circle[], _order: number[], r: number): string {
  const whites = circles.filter((c) => c.on);
  const blacks = circles.filter((c) => !c.on);
  if (whites.length === 0) return "";
  if (whites.length === 1) {
    const c = whites[0];
    return [
      `M ${fmt(c.x - r)} ${fmt(c.y)}`,
      `A ${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(c.x + r)} ${fmt(c.y)}`,
      `A ${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(c.x - r)} ${fmt(c.y)}`,
      "Z",
    ].join(" ");
  }

  const hull = convexHull(whites);
  // hull is CCW in math coords (y up). In SVG (y down), CCW math = CW visual.
  // We want the boundary to go around the cluster with the interior on its
  // INSIDE. Walking CW visually with interior on right means the outer
  // tangent should sit on the LEFT of motion in SVG = the −v side.

  type Entry =
    | { kind: "circle"; circle: Circle; w: Winding }
    | never;
  const entries: Entry[] = [];
  const EPS = 1e-6;

  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    entries.push({ kind: "circle", circle: a, w: -1 });

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d < EPS) continue;
    const ux = dx / d;
    const uy = dy / d;
    // Outside of the hull = LEFT of motion in SVG (since hull walk is CW
    // visually) = −v side, where v = (−uy, ux).
    const vx = -uy;
    const vy = ux;
    const outsidePerp = -r; // tangent line offset on the −v side at distance r

    // A black blocks this outer tangent when its disc crosses the tangent
    // line within the segment's projection range, on the same (outside) side.
    const blocking = blacks
      .map((B) => ({
        B,
        proj: (B.x - a.x) * ux + (B.y - a.y) * uy,
        perp: (B.x - a.x) * vx + (B.y - a.y) * vy,
      }))
      .filter(
        ({ proj, perp }) =>
          proj > -r + EPS &&
          proj < d + r - EPS &&
          perp < outsidePerp + 2 * r - EPS &&
          perp > outsidePerp - EPS,
      )
      .sort((x, y) => x.proj - y.proj);

    for (const { B } of blocking) {
      entries.push({ kind: "circle", circle: B, w: 1 });
    }
  }

  const n = entries.length;
  const segments: Segment[] = [];
  for (let i = 0; i < n; i += 1) {
    const e = entries[i];
    const f = entries[(i + 1) % n];
    segments.push(computeSegment(e.circle, f.circle, e.w, f.w, r, false));
  }

  const parts: string[] = [
    `M ${fmt(segments[0].pFrom.x)} ${fmt(segments[0].pFrom.y)}`,
  ];
  for (let i = 0; i < n; i += 1) {
    const seg = segments[i];
    const next = segments[(i + 1) % n];
    parts.push(`L ${fmt(seg.pTo.x)} ${fmt(seg.pTo.y)}`);
    parts.push(buildArcCommand(seg.to, seg.pTo, next.pFrom, seg.wTo, r));
  }
  parts.push("Z");
  return parts.join(" ");
}

// Andrew's monotone chain. Returns the hull in CCW order in MATH coords
// (which is CW order visually in SVG, because +y points down).
function convexHull(points: Circle[]): Circle[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Circle, a: Circle, b: Circle) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Circle[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Circle[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function buildModel(
  grid: number,
  radius: number,
  gap: number,
  states: boolean[],
): Model {
  const spacing = radius * 2 + gap;
  const padding = radius + Math.max(20, radius * 0.7);
  const size = padding * 2 + radius * 2 + (grid - 1) * spacing;

  const circles: Circle[] = [];
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      const index = row * grid + col;
      circles.push({
        index,
        row,
        col,
        on: states[index] ?? false,
        x: padding + radius + col * spacing,
        y: padding + radius + row * spacing,
      });
    }
  }

  const order = serpentineOrder(grid);
  const pathData = buildPath(circles, order, radius);
  const svgMarkup = buildSvgMarkup(size, pathData);

  return { circles, pathData, size, svgMarkup };
}

function buildSvgMarkup(size: number, pathData: string) {
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(size)} ${fmt(size)}">`,
    `  <rect width="${fmt(size)}" height="${fmt(size)}" fill="${BACKGROUND}"/>`,
  ];
  if (pathData) {
    lines.push(`  <path d="${pathData}" fill="white" fill-rule="evenodd"/>`);
  }
  lines.push("</svg>");
  return lines.join("\n");
}

function downloadSvg(filename: string, content: string) {
  const blob = new Blob([content], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function ShapeStudio({ initialSeed }: { initialSeed: number }) {
  const [grid, setGrid] = useState(DEFAULT_GRID);
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [gap, setGap] = useState(DEFAULT_GAP);
  const [states, setStates] = useState<boolean[]>(() =>
    randomStates(DEFAULT_GRID * DEFAULT_GRID, initialSeed),
  );
  const [showHelpers, setShowHelpers] = useState(true);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const model = useMemo(
    () => buildModel(grid, radius, gap, states),
    [grid, radius, gap, states],
  );

  const onCount = states.filter(Boolean).length;
  const offCount = states.length - onCount;

  function changeGrid(value: number) {
    const next = clamp(Math.round(value), MIN_GRID, MAX_GRID);
    if (next === grid) return;
    startTransition(() => {
      setGrid(next);
      setStates(randomStates(next * next, randomSeed()));
    });
  }

  function changeRadius(value: number) {
    setRadius(clamp(Math.round(value), MIN_RADIUS, MAX_RADIUS));
  }

  function changeGap(value: number) {
    setGap(clamp(Math.round(value), MIN_GAP, MAX_GAP));
  }

  function shuffle() {
    startTransition(() => {
      setStates(randomStates(grid * grid, randomSeed()));
    });
  }

  function toggle(index: number) {
    setStates((current) =>
      current.map((value, i) => (i === index ? !value : value)),
    );
  }

  function exportSvg() {
    downloadSvg(`hofmann-${grid}x${grid}.svg`, model.svgMarkup);
  }

  return (
    <div className="min-h-screen bg-stone-100 text-stone-950">
      <main className="grid min-h-screen lg:grid-cols-[24rem_minmax(0,1fr)]">
        <aside className="border-b border-stone-300 bg-stone-50 p-6 lg:border-r lg:border-b-0">
          <div className="mx-auto flex h-full max-w-md flex-col gap-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.3em] text-stone-500">
                After Armin Hofmann, 1965
              </p>
              <h1 className="mt-2 text-3xl leading-none tracking-tight">
                Tangent forms
              </h1>
              <p className="mt-3 text-sm leading-6 text-stone-600">
                White circles (on) are enclosed by a single filled shape built
                from common outer tangents and arcs around each one. Black
                circles (off) are left out of the shape entirely.
              </p>
            </div>

            <div className="space-y-5 border border-stone-300 bg-white p-5">
              <Slider
                label="Grid"
                min={MIN_GRID}
                max={MAX_GRID}
                value={grid}
                onChange={changeGrid}
                valueLabel={`${grid} × ${grid}`}
              />
              <Slider
                label="Radius"
                min={MIN_RADIUS}
                max={MAX_RADIUS}
                value={radius}
                onChange={changeRadius}
                valueLabel={`${radius} px`}
              />
              <Slider
                label="Gap"
                min={MIN_GAP}
                max={MAX_GAP}
                value={gap}
                onChange={changeGap}
                valueLabel={`${gap} px`}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={shuffle}
                className="rounded-full border border-black bg-black px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-800"
              >
                Shuffle
              </button>
              <button
                type="button"
                onClick={exportSvg}
                className="rounded-full border border-black bg-white px-4 py-3 text-sm font-medium text-black transition-colors hover:bg-stone-100"
              >
                Export SVG
              </button>
            </div>

            <label className="flex items-center gap-3 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={showHelpers}
                onChange={(event) => setShowHelpers(event.target.checked)}
                className="h-4 w-4 accent-black"
              />
              Show helper circles
            </label>

            <div className="mt-auto grid grid-cols-2 gap-3">
              <Stat label="white" value={onCount} />
              <Stat label="black" value={offCount} />
            </div>
          </div>
        </aside>

        <section
          className="flex min-h-[60vh] items-center justify-center p-6"
          style={{ background: BACKGROUND }}
        >
          <svg
            viewBox={`0 0 ${model.size} ${model.size}`}
            className="h-full max-h-[90vh] w-full max-w-[960px]"
            aria-label="Shape canvas"
          >
            <rect width={model.size} height={model.size} fill={BACKGROUND} />
            {model.pathData ? (
              <path
                d={model.pathData}
                fill="white"
                fillRule="evenodd"
                pointerEvents="none"
              />
            ) : null}

            {model.circles.map((circle) => {
              const isHover = hoverIndex === circle.index;
              return (
                <g
                  key={circle.index}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverIndex(circle.index)}
                  onMouseLeave={() =>
                    setHoverIndex((current) =>
                      current === circle.index ? null : current,
                    )
                  }
                  onClick={() => toggle(circle.index)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Toggle circle row ${circle.row + 1}, column ${
                    circle.col + 1
                  }`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggle(circle.index);
                    }
                  }}
                >
                  <circle
                    cx={circle.x}
                    cy={circle.y}
                    r={radius + Math.max(4, radius * 0.18)}
                    fill="transparent"
                    pointerEvents="all"
                  />
                  {showHelpers ? (
                    <circle
                      cx={circle.x}
                      cy={circle.y}
                      r={radius}
                      fill="none"
                      stroke={
                        circle.on ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.55)"
                      }
                      strokeWidth={1}
                      pointerEvents="none"
                    />
                  ) : null}
                  {isHover ? (
                    <circle
                      cx={circle.x}
                      cy={circle.y}
                      r={radius}
                      fill="none"
                      stroke={circle.on ? "black" : "white"}
                      strokeWidth={2}
                      pointerEvents="none"
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
        </section>
      </main>
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  value,
  onChange,
  valueLabel,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  valueLabel: string;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-stone-900">{label}</span>
        <span className="font-mono text-sm text-stone-500">{valueLabel}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className="mt-3 w-full accent-black"
      />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-stone-300 bg-white p-3">
      <div className="font-mono text-xs uppercase tracking-widest text-stone-400">
        {label}
      </div>
      <div className="mt-1 text-lg text-stone-900">{value}</div>
    </div>
  );
}
