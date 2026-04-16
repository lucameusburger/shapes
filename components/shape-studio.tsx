"use client";

import { startTransition, useState } from "react";

const DEFAULT_GRID_SIZE = 5;
const DEFAULT_RADIUS = 26;
const DEFAULT_GAP = 18;
const MIN_GRID_SIZE = 2;
const MAX_GRID_SIZE = 10;
const MIN_RADIUS = 10;
const MAX_RADIUS = 42;
const MIN_GAP = 0;
const MAX_GAP = 48;

type Point = {
  x: number;
  y: number;
};

type CircleNode = Point & {
  column: number;
  filled: boolean;
  index: number;
  row: number;
};

type EditorState = {
  cells: boolean[];
  circleRadius: number;
  gap: number;
  gridSize: number;
};

type FlowState = "A" | "O";

type FlowSegment = {
  centerA: Point;
  centerB: Point;
  end: Point;
  flowA: FlowState;
  flowB: FlowState;
  start: Point;
};

type SvgModel = {
  blackCount: number;
  circles: CircleNode[];
  height: number;
  pathData: string;
  strokeWidth: number;
  svgMarkup: string;
  width: number;
  whiteCount: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSeed(seed: number) {
  if (!Number.isFinite(seed)) {
    return 1;
  }

  const safeSeed = Math.floor(seed) % 2147483647;
  return safeSeed <= 0 ? safeSeed + 2147483646 : safeSeed;
}

function createRng(seed: number) {
  let value = normalizeSeed(seed);

  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function createRandomCells(count: number, seed: number) {
  const next = createRng(seed);
  return Array.from({ length: count }, () => next() > 0.5);
}

function createSpiralOrder(size: number) {
  const order: number[] = [];
  let top = 0;
  let bottom = size - 1;
  let left = 0;
  let right = size - 1;

  while (left <= right && top <= bottom) {
    for (let column = left; column <= right; column += 1) {
      order.push(top * size + column);
    }
    top += 1;

    for (let row = top; row <= bottom; row += 1) {
      order.push(row * size + right);
    }
    right -= 1;

    if (top <= bottom) {
      for (let column = right; column >= left; column -= 1) {
        order.push(bottom * size + column);
      }
      bottom -= 1;
    }

    if (left <= right) {
      for (let row = bottom; row >= top; row -= 1) {
        order.push(row * size + left);
      }
      left += 1;
    }
  }

  return order;
}

function calculateInternalOffset(distanceHalf: number, radius: number) {
  if (distanceHalf <= radius) {
    return {
      x: 0,
      y: radius,
    } satisfies Point;
  }

  const slope = Math.sqrt((radius * radius) / (distanceHalf * distanceHalf - radius * radius));
  const x = distanceHalf / (1 + slope * slope);

  return {
    x,
    y: slope * x,
  } satisfies Point;
}

function getFlowState(circle: CircleNode): FlowState {
  return circle.filled ? "A" : "O";
}

function getFlowTangentPoints(
  distanceHalf: number,
  radius: number,
  flowA: FlowState,
  flowB: FlowState,
): [Point, Point] {
  if (flowA === "O" && flowB === "O") {
    return [
      { x: -distanceHalf, y: -radius },
      { x: distanceHalf, y: -radius },
    ];
  }

  if (flowA === "A" && flowB === "A") {
    return [
      { x: -distanceHalf, y: radius },
      { x: distanceHalf, y: radius },
    ];
  }

  const { x, y } = calculateInternalOffset(distanceHalf, radius);

  if (flowA === "O" && flowB === "A") {
    return [
      { x: -x, y: -y },
      { x, y },
    ];
  }

  return [
    { x: -x, y },
    { x, y: -y },
  ];
}

function rotatePoint(point: Point, center: Point, angle: number) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  return {
    x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle),
  } satisfies Point;
}

function computeFlowSegment(current: CircleNode, next: CircleNode, radius: number) {
  const centerA = { x: current.x, y: current.y };
  const centerB = { x: next.x, y: next.y };
  const dx = centerB.x - centerA.x;
  const dy = centerB.y - centerA.y;
  const midpoint = {
    x: centerA.x + dx / 2,
    y: centerA.y + dy / 2,
  } satisfies Point;
  const angle = Math.atan2(dy, dx);
  const distanceHalf = Math.hypot(dx, dy) / 2;
  const flowA = getFlowState(current);
  const flowB = getFlowState(next);
  const [localStart, localEnd] = getFlowTangentPoints(distanceHalf, radius, flowA, flowB);

  return {
    centerA,
    centerB,
    flowA,
    flowB,
    start: rotatePoint(
      {
        x: midpoint.x + localStart.x,
        y: midpoint.y + localStart.y,
      },
      midpoint,
      angle,
    ),
    end: rotatePoint(
      {
        x: midpoint.x + localEnd.x,
        y: midpoint.y + localEnd.y,
      },
      midpoint,
      angle,
    ),
  } satisfies FlowSegment;
}

function formatNumber(value: number) {
  return Number(value.toFixed(2)).toString();
}

function formatPoint(point: Point) {
  return `${formatNumber(point.x)} ${formatNumber(point.y)}`;
}

function buildArcCommand(current: FlowSegment, next: FlowSegment, radius: number) {
  const startAngle = Math.atan2(
    current.end.y - current.centerB.y,
    current.end.x - current.centerB.x,
  );
  let endAngle = Math.atan2(
    next.start.y - next.centerA.y,
    next.start.x - next.centerA.x,
  );

  if (startAngle < endAngle && current.flowB === "A") {
    endAngle -= Math.PI * 2;
  } else if (startAngle > endAngle && current.flowB === "O") {
    endAngle += Math.PI * 2;
  }

  const sweepFlag = endAngle - startAngle > 0 ? 1 : 0;
  return `A ${formatNumber(radius)} ${formatNumber(radius)} 0 0 ${sweepFlag} ${formatPoint(next.start)}`;
}

function buildClosedPath(segments: FlowSegment[], radius: number) {
  if (segments.length === 0) {
    return "";
  }

  const commands = [
    `M ${formatPoint(segments[0].start)}`,
    `L ${formatPoint(segments[0].end)}`,
  ];

  for (let index = 0; index < segments.length; index += 1) {
    const nextIndex = (index + 1) % segments.length;
    commands.push(buildArcCommand(segments[index], segments[nextIndex], radius));

    if (nextIndex !== 0) {
      commands.push(`L ${formatPoint(segments[nextIndex].end)}`);
    }
  }

  commands.push("Z");

  return commands.join(" ");
}

function buildSvgMarkup({
  circleRadius,
  circles,
  height,
  pathData,
  width,
}: {
  circleRadius: number;
  circles: CircleNode[];
  height: number;
  pathData: string;
  width: number;
}) {
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${formatNumber(width)} ${formatNumber(height)}" fill="none">`,
    `  <rect width="${formatNumber(width)}" height="${formatNumber(height)}" fill="black" />`,
  ];

  if (pathData) {
    lines.push(`  <path d="${pathData}" fill="white" />`);
  }

  for (const circle of circles) {
    lines.push(
      `  <circle cx="${formatNumber(circle.x)}" cy="${formatNumber(circle.y)}" r="${formatNumber(circleRadius)}" fill="${circle.filled ? "black" : "white"}" />`,
    );
  }

  lines.push(`</svg>`);

  return lines.join("\n");
}

function buildSvgModel(state: EditorState) {
  const spacing = state.circleRadius * 2 + state.gap;
  const padding = Math.max(34, state.circleRadius + state.gap + state.circleRadius / 2);
  const width = padding * 2 + state.circleRadius * 2 + (state.gridSize - 1) * spacing;
  const height = width;
  const strokeWidth = Math.max(1.75, state.circleRadius * 0.12);

  const circles: CircleNode[] = [];
  let blackCount = 0;

  for (let row = 0; row < state.gridSize; row += 1) {
    for (let column = 0; column < state.gridSize; column += 1) {
      const index = row * state.gridSize + column;
      const filled = state.cells[index] ?? false;

      if (filled) {
        blackCount += 1;
      }

      circles.push({
        index,
        row,
        column,
        filled,
        x: padding + state.circleRadius + column * spacing,
        y: padding + state.circleRadius + row * spacing,
      });
    }
  }

  const orderedCircles = createSpiralOrder(state.gridSize).map((index) => circles[index]);
  const whiteCount = circles.length - blackCount;
  const segments =
    whiteCount === 0
      ? []
      : orderedCircles.map((circle, index) =>
          computeFlowSegment(
            circle,
            orderedCircles[(index + 1) % orderedCircles.length],
            state.circleRadius,
          ),
        );
  const pathData = buildClosedPath(segments, state.circleRadius);
  const svgMarkup = buildSvgMarkup({
    circleRadius: state.circleRadius,
    circles,
    pathData,
    width,
    height,
  });

  return {
    circles,
    pathData,
    width,
    height,
    strokeWidth,
    svgMarkup,
    blackCount,
    whiteCount,
  } satisfies SvgModel;
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

function parseInput(nextValue: number, min: number, max: number) {
  if (!Number.isFinite(nextValue)) {
    return null;
  }

  return clamp(Math.round(nextValue), min, max);
}

function downloadSvg(filename: string, content: string) {
  const blob = new Blob([content], {
    type: "image/svg+xml;charset=utf-8",
  });
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
  const [editor, setEditor] = useState<EditorState>(() => ({
    gridSize: DEFAULT_GRID_SIZE,
    circleRadius: DEFAULT_RADIUS,
    gap: DEFAULT_GAP,
    cells: createRandomCells(DEFAULT_GRID_SIZE * DEFAULT_GRID_SIZE, initialSeed),
  }));
  const [activeCircleIndex, setActiveCircleIndex] = useState<number | null>(null);

  const svgModel = buildSvgModel(editor);
  const hoverStrokeWidth = Math.max(0.75, svgModel.strokeWidth * 0.32);

  function updateGridSize(nextValue: number) {
    const nextGridSize = parseInput(nextValue, MIN_GRID_SIZE, MAX_GRID_SIZE);

    if (nextGridSize === null) {
      return;
    }

    startTransition(() => {
      setEditor((current) => ({
        ...current,
        gridSize: nextGridSize,
        cells: createRandomCells(nextGridSize * nextGridSize, randomSeed()),
      }));
    });
  }

  function updateCircleRadius(nextValue: number) {
    const nextRadius = parseInput(nextValue, MIN_RADIUS, MAX_RADIUS);

    if (nextRadius === null) {
      return;
    }

    setEditor((current) => ({
      ...current,
      circleRadius: nextRadius,
    }));
  }

  function updateGap(nextValue: number) {
    const nextGap = parseInput(nextValue, MIN_GAP, MAX_GAP);

    if (nextGap === null) {
      return;
    }

    setEditor((current) => ({
      ...current,
      gap: nextGap,
    }));
  }

  function toggleCircle(index: number) {
    setEditor((current) => ({
      ...current,
      cells: current.cells.map((cell, cellIndex) =>
        cellIndex === index ? !cell : cell,
      ),
    }));
  }

  function shuffleCells() {
    startTransition(() => {
      setEditor((current) => ({
        ...current,
        cells: createRandomCells(current.gridSize * current.gridSize, randomSeed()),
      }));
    });
  }

  function exportSvg() {
    downloadSvg(`shapes-${editor.gridSize}x${editor.gridSize}.svg`, svgModel.svgMarkup);
  }

  return (
    <div className="min-h-screen bg-stone-200 text-stone-950">
      <main className="grid min-h-screen lg:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="border-b border-stone-300 bg-stone-100 p-5 sm:p-6 lg:border-r lg:border-b-0">
          <div className="mx-auto flex h-full max-w-md flex-col gap-6">
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-stone-500">
                Shapes Studio
              </p>
              <div className="border border-stone-300 bg-white p-5">
                <h1 className="text-3xl leading-none tracking-tight">
                  Black / White Tangents
                </h1>
                <p className="mt-3 text-sm leading-6 text-stone-600">
                  Click circles to flip them. Matching fills create outer tangents,
                  opposite fills switch to inner tangents, and the line closes back
                  into itself.
                </p>
              </div>
            </div>

            <div className="space-y-5 border border-stone-300 bg-white p-5">
              <Control
                caption="Changing the grid reseeds the full arrangement."
                label="Grid"
                max={MAX_GRID_SIZE}
                min={MIN_GRID_SIZE}
                onChange={updateGridSize}
                value={editor.gridSize}
                valueLabel={`${editor.gridSize} x ${editor.gridSize}`}
              />
              <Control
                caption="The SVG updates live while you scale the circles."
                label="Circle Radius"
                max={MAX_RADIUS}
                min={MIN_RADIUS}
                onChange={updateCircleRadius}
                value={editor.circleRadius}
                valueLabel={`${editor.circleRadius}px`}
              />
              <Control
                caption="Gap affects both the rhythm of the grid and the tangent angle."
                label="Gap"
                max={MAX_GAP}
                min={MIN_GAP}
                onChange={updateGap}
                value={editor.gap}
                valueLabel={`${editor.gap}px`}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={shuffleCells}
                className="rounded-full border border-black bg-black px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-800"
              >
                Shuffle Toggles
              </button>
              <button
                type="button"
                onClick={exportSvg}
                className="rounded-full border border-black bg-white px-4 py-3 text-sm font-medium text-black transition-colors hover:bg-stone-100"
              >
                Export SVG
              </button>
            </div>

            <div className="border border-stone-300 bg-stone-50 p-4 text-sm leading-6 text-stone-600">
              After Armin Hofmann, 1965. The helper circles stay interactive on the
              artboard, while export keeps the black field and the white filled form.
            </div>
          </div>
        </aside>

        <section className="flex min-h-[60vh] flex-col bg-stone-950 text-white">
          <header className="border-b border-stone-800 px-5 py-4 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex gap-3 text-sm text-stone-300">
                <div className="rounded-full border border-stone-700 px-3 py-1.5">
                  Black {svgModel.blackCount}
                </div>
                <div className="rounded-full border border-stone-700 px-3 py-1.5">
                  White {svgModel.whiteCount}
                </div>
              </div>
            </div>
          </header>

          <div className="flex-1 p-4 sm:p-6">
            <div className="flex h-full min-h-[420px] items-center justify-center bg-black">
              <svg
                viewBox={`0 0 ${svgModel.width} ${svgModel.height}`}
                className="h-full max-h-[78vh] w-full max-w-[980px]"
                aria-label="Shape editor canvas"
              >
                <rect width={svgModel.width} height={svgModel.height} fill="black" />

                <path d={svgModel.pathData} fill="white" pointerEvents="none" />

                {svgModel.circles.map((circle) => (
                  <g
                    key={circle.index}
                    role="button"
                    tabIndex={0}
                    aria-label={`Toggle circle ${circle.row + 1}, ${circle.column + 1} to ${circle.filled ? "white" : "black"}`}
                    className="cursor-pointer"
                    onMouseEnter={() => setActiveCircleIndex(circle.index)}
                    onMouseLeave={() => setActiveCircleIndex((current) => (current === circle.index ? null : current))}
                    onFocus={() => setActiveCircleIndex(circle.index)}
                    onBlur={() => setActiveCircleIndex((current) => (current === circle.index ? null : current))}
                    onClick={() => toggleCircle(circle.index)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleCircle(circle.index);
                      }
                    }}
                  >
                    <circle
                      cx={circle.x}
                      cy={circle.y}
                      r={editor.circleRadius + Math.max(6, editor.circleRadius * 0.22)}
                      fill="transparent"
                      pointerEvents="all"
                    />
                    <circle
                      cx={circle.x}
                      cy={circle.y}
                      r={editor.circleRadius}
                      fill={circle.filled ? "black" : "white"}
                      pointerEvents="none"
                    />
                    {activeCircleIndex === circle.index ? (
                      <circle
                        cx={circle.x}
                        cy={circle.y}
                        r={editor.circleRadius}
                        fill="none"
                        stroke={circle.filled ? "white" : "black"}
                        strokeWidth={hoverStrokeWidth}
                        pointerEvents="none"
                      />
                    ) : null}
                  </g>
                ))}
              </svg>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Control({
  caption,
  label,
  max,
  min,
  onChange,
  value,
  valueLabel,
}: {
  caption: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  value: number;
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
      <div className="mt-3 flex items-center gap-3">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          className="w-24 rounded-full border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition-colors focus:border-black"
        />
        <p className="text-sm leading-6 text-stone-500">{caption}</p>
      </div>
    </label>
  );
}
