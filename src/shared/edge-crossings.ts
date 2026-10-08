// Crossing number of a graph drawn with straight center-to-center edges: how many pairs of
// segments properly intersect. The canvas draws bowed splines; the linter uses this simpler
// model so it can judge layout without importing client geometry. It never reads the canvas
// layer either, so a bend dragged into an edge there does not change the count: only moving nodes
// does, and the warning says so.
//
// A proper intersection is two segment interiors crossing. Shared endpoints, collinear overlap,
// and zero-length segments (self-loops) do not count.

export interface CrossingPoint {
  x: number;
  y: number;
}

export interface CrossingSegment {
  from: CrossingPoint;
  to: CrossingPoint;
}

export function countCrossingPairs(segments: CrossingSegment[]): number {
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    const first = segments[i];
    if (isDegenerate(first)) continue;
    for (let j = i + 1; j < segments.length; j++) {
      const second = segments[j];
      if (isDegenerate(second)) continue;
      if (segmentsCross(first, second)) crossings += 1;
    }
  }
  return crossings;
}

function segmentsCross(first: CrossingSegment, second: CrossingSegment): boolean {
  const d1 = orient(first.from, first.to, second.from);
  const d2 = orient(first.from, first.to, second.to);
  const d3 = orient(second.from, second.to, first.from);
  const d4 = orient(second.from, second.to, first.to);
  return straddles(d1, d2) && straddles(d3, d4);
}

function straddles(first: number, second: number): boolean {
  return (first > 0 && second < 0) || (first < 0 && second > 0);
}

function orient(origin: CrossingPoint, toward: CrossingPoint, point: CrossingPoint): number {
  return (toward.x - origin.x) * (point.y - origin.y) - (toward.y - origin.y) * (point.x - origin.x);
}

function isDegenerate(segment: CrossingSegment): boolean {
  return segment.from.x === segment.to.x && segment.from.y === segment.to.y;
}
