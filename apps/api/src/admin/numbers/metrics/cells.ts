import { ADMIN_FUNNEL_K_ANON_FLOOR } from "../../admin-funnel.dto";
import {
  NUMBERS_ALL_GROUP,
  NUMBERS_CITY_GROUPS,
  NUMBERS_CITY_GROUP_LABELS,
  NUMBERS_TRADE_GROUPS,
  NUMBERS_TRADE_GROUP_LABELS,
  NUMBERS_UNKNOWN_GROUP,
  type NumbersCityGroup,
  type NumbersCityGroupLabel,
  type NumbersTradeGroup,
  type NumbersTradeGroupLabel,
} from "../groups";

/**
 * #2755 part B — THE CELL GRID of the weekly snapshot, and the one place a figure is split.
 *
 * Every snapshot metric is stored once per city label × trade label, the `all` roll-ups included:
 * 6 × 7 = 42 cells. Every entity (a company, a worker, an order) sits in exactly ONE leaf cell
 * (its city group × its trade group, from `groups.ts`), and the roll-ups are summed from the
 * ENTITIES' leaf totals here, never from stored cells: a stored suppressed cell holds no number,
 * so nothing downstream ever needs to add cells together.
 *
 * Pure: no clock, no database.
 */

/** Where one entity sits: a city group and a trade group (never `all`). */
export interface NumbersDims {
  readonly city: NumbersCityGroup;
  readonly trade: NumbersTradeGroup;
}

/** Where an entity with no recorded city or trade sits. */
export const UNKNOWN_DIMS: NumbersDims = {
  city: NUMBERS_UNKNOWN_GROUP,
  trade: NUMBERS_UNKNOWN_GROUP,
};

/** One stored cell of one metric. */
export interface NumbersCell {
  readonly cityGroup: NumbersCityGroupLabel;
  readonly tradeGroup: NumbersTradeGroupLabel;
  /** The figure (count, paise, or a ratio in hundredths); null when suppressed or not computable. */
  readonly value: number | null;
  /** A ratio's or a share's top term; null otherwise. */
  readonly numerator: number | null;
  /** A ratio's or a share's bottom term; null otherwise. */
  readonly denominator: number | null;
  readonly suppressed: boolean;
}

/** One metric's 42 cells. */
export interface NumbersMetricCells {
  readonly metric: string;
  readonly cells: readonly NumbersCell[];
}

/** Every (city label, trade label) pair, the roll-ups included, in a stable order. */
export function cellGrid(): Array<{
  cityGroup: NumbersCityGroupLabel;
  tradeGroup: NumbersTradeGroupLabel;
}> {
  return NUMBERS_CITY_GROUP_LABELS.flatMap((cityGroup) =>
    NUMBERS_TRADE_GROUP_LABELS.map((tradeGroup) => ({ cityGroup, tradeGroup })),
  );
}

/** Does an entity at `dims` belong in the cell (`city`, `trade`)? `all` takes every group. */
function inCell(
  dims: NumbersDims,
  city: NumbersCityGroupLabel,
  trade: NumbersTradeGroupLabel,
): boolean {
  return (
    (city === NUMBERS_ALL_GROUP || dims.city === city) &&
    (trade === NUMBERS_ALL_GROUP || dims.trade === trade)
  );
}

/**
 * The per-cell SUM of `amount` over the entities, from their leaves, for all 42 cells. A count is
 * a sum of ones. Every cell is present, a zero where no entity sits.
 */
export function sumByCell<T>(
  items: readonly T[],
  dimsOf: (item: T) => NumbersDims,
  amountOf: (item: T) => number = () => 1,
): Map<string, number> {
  // Leaf totals first (36 cells at most), then every label pair from them.
  const leaves = new Map<string, number>();
  for (const item of items) {
    const d = dimsOf(item);
    const key = `${d.city}|${d.trade}`;
    leaves.set(key, (leaves.get(key) ?? 0) + amountOf(item));
  }
  const out = new Map<string, number>();
  for (const { cityGroup, tradeGroup } of cellGrid()) {
    let total = 0;
    for (const city of NUMBERS_CITY_GROUPS) {
      for (const trade of NUMBERS_TRADE_GROUPS) {
        if (!inCell({ city, trade }, cityGroup, tradeGroup)) continue;
        total += leaves.get(`${city}|${trade}`) ?? 0;
      }
    }
    out.set(cellKey(cityGroup, tradeGroup), total);
  }
  return out;
}

/** The map key of one cell. */
export function cellKey(city: NumbersCityGroupLabel, trade: NumbersTradeGroupLabel): string {
  return `${city}|${trade}`;
}

/** A count or a sum, one value per cell. */
export function valueCells(
  metric: string,
  totals: ReadonlyMap<string, number>,
): NumbersMetricCells {
  return {
    metric,
    cells: cellGrid().map(({ cityGroup, tradeGroup }) => ({
      cityGroup,
      tradeGroup,
      value: totals.get(cellKey(cityGroup, tradeGroup)) ?? 0,
      numerator: null,
      denominator: null,
      suppressed: false,
    })),
  };
}

/** Distinct entities per cell: each key counted once, at the dims of its first appearance. */
export function distinctCountCells<T>(
  metric: string,
  items: readonly T[],
  keyOf: (item: T) => string,
  dimsOf: (item: T) => NumbersDims,
): NumbersMetricCells {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return valueCells(metric, sumByCell([...seen.values()], dimsOf));
}

/**
 * A ratio of two per-cell totals: numerator and denominator stored, the value the quotient in
 * HUNDREDTHS rounded half up (2.50 contacts per hire is 250), null when the denominator is 0.
 */
export function ratioCells(
  metric: string,
  numerators: ReadonlyMap<string, number>,
  denominators: ReadonlyMap<string, number>,
): NumbersMetricCells {
  return {
    metric,
    cells: cellGrid().map(({ cityGroup, tradeGroup }) => {
      const key = cellKey(cityGroup, tradeGroup);
      const numerator = numerators.get(key) ?? 0;
      const denominator = denominators.get(key) ?? 0;
      return {
        cityGroup,
        tradeGroup,
        value: denominator === 0 ? null : hundredths(numerator, denominator),
        numerator,
        denominator,
        suppressed: false,
      };
    }),
  };
}

/** `numerator / denominator` in hundredths, rounded half up (integers only: no float drift). */
export function hundredths(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError("hundredths needs a positive denominator");
  return Math.floor((numerator * 200 + denominator) / (2 * denominator));
}

/** The small-cell floor of worker figures: the onboarding funnel's (5). */
export const NUMBERS_SMALL_CELL_FLOOR = ADMIN_FUNNEL_K_ANON_FLOOR;

/**
 * Suppress a WORKER figure's small cells: a cell whose value is under the floor (zero included)
 * keeps no number at all (value, numerator and denominator NULL, `suppressed`), so a filter can
 * never single a worker out. The `all × all` total is never suppressed: it is the screen's headline
 * and names no city or trade.
 */
export function suppressSmallCells(
  cells: NumbersMetricCells,
  floor: number = NUMBERS_SMALL_CELL_FLOOR,
): NumbersMetricCells {
  return {
    metric: cells.metric,
    cells: cells.cells.map((cell) => {
      const isTotal = cell.cityGroup === NUMBERS_ALL_GROUP && cell.tradeGroup === NUMBERS_ALL_GROUP;
      if (isTotal || cell.value === null || cell.value >= floor) return cell;
      return { ...cell, value: null, numerator: null, denominator: null, suppressed: true };
    }),
  };
}
