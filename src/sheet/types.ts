/**
 * Shared types of the sheet import path: slice → matte → register → group → write.
 * Coordinates are integer pixels; boxes are `{ x, y, width, height }` with x, y the top-left.
 */
import type { Raster } from "../image/raster.ts";
import type { Box, Point, Rgb, Size, Transform } from "../types.ts";

/** One figure found on the sheet, before background removal. */
export interface SlicedFigure {
  /** 1-based number in reading order (rows top to bottom, then left to right). */
  id: number;
  /** The grid cell it sits in; without a grid, its row and column in reading order. */
  cell: { row: number; column: number; box: Box };
  /**
   * The crop's box in sheet coordinates: the figure's extent plus padding, clipped to its cell when
   * the grid was given (a detected grid's cells only order the figures, so nothing is clipped).
   */
  box: Box;
  /** The sheet's pixels inside `box`, unchanged (RGBA; alpha is whatever the sheet had). */
  crop: Raster;
  /**
   * Per crop pixel (row-major, crop.width * crop.height): 1 where the pixel belongs to the figure
   * (its foreground components), 0 elsewhere. Labels, specks, neighbouring figures and background,
   * enclosed background included, are 0, so they never reach a frame.
   */
  mask: Uint8Array;
  /**
   * Per crop pixel: 1 on other foreground in the crop (labels, specks, neighbours) and its fringe.
   * Matting gives these pixels alpha 0 even beside the figure. Optional for hand-built figures.
   */
  excluded?: Uint8Array;
  /** The background colour estimated for this figure's cell (or neighbourhood). */
  background: Rgb;
  /** What slicing did to reach this figure, for provenance: crop, label and speck removal. */
  transforms: Transform[];
}

export interface SliceResult {
  mode: "grid" | "components";
  /** The grid, when one was given or detected. */
  grid?: { columns: number; rows: number; cell: Size; origin: Point };
  /** The sheet-wide background estimate (median of the border pixels). */
  background: Rgb;
  figures: SlicedFigure[];
}

export interface SliceOptions {
  /**
   * An explicit grid: columns (and optionally rows, cell size and origin). When absent the grid is
   * detected; when none is detected the figures are located as connected components.
   */
  grid?: {
    columns: number;
    rows?: number;
    cellWidth?: number;
    cellHeight?: number;
    origin?: Point;
  };
  /**
   * The number of figures the sheet must hold (a spec's `frames.count`). Slicing refuses a sheet
   * that holds another number with a SliceError naming the cells or figures behind the difference.
   */
  count?: number;
  /** Skip grid detection and locate figures as connected components. Default false. */
  components?: boolean;
  /** RGB distance from the background beyond which a pixel is foreground. Default 40. */
  tolerance?: number;
  /** A component smaller than this fraction of the largest figure is a label or speck. Default 0.04. */
  labelFraction?: number;
  /** Padding in px kept around each figure's extent in the crop. Default 4. */
  padding?: number;
}

/** A figure with its background removed: straight (not premultiplied) RGBA at sheet resolution. */
export interface MattedFigure {
  image: Raster;
  /** Edge-quality measurements for the halo and leftover-background check. */
  quality: MatteQuality;
  transforms: Transform[];
}

export interface MatteQuality {
  /** Pixels with 0 < alpha < 255. */
  softPixels: number;
  /** Visible pixels (alpha > 0) next to a transparent one whose colour is within tolerance of the background. */
  haloPixels: number;
  /** All visible edge pixels (alpha > 0 next to a transparent one). */
  edgePixels: number;
  /** haloPixels / edgePixels (0 when there is no edge). */
  haloFraction: number;
  /** Visible pixels (alpha > 0). */
  visiblePixels: number;
  /**
   * Opaque interior pixels (alpha 255, not on the edge) that are the background colour itself:
   * leftover background inside the figure. 0 for source-alpha sheets, whose background is alpha.
   */
  backgroundPixels: number;
}

/** Where a frame sits after registration, measured on the registered frame. */
export interface FrameMeasure {
  /** The lowest row with alpha >= the measuring threshold (the feet baseline), in frame px. */
  baseline: number;
  /** Alpha-weighted centre of mass, in frame px. */
  centerX: number;
  centerY: number;
  /** Sum of alpha / 255 (the opaque area in px). */
  area: number;
}

export interface RegisterOptions {
  /** The target's frame size. */
  frame: Size;
  /** The pivot: the feet baseline goes to anchor.y and the centre of mass to anchor.x. */
  anchor: Point;
  /** `crisp` resamples nearest-neighbour; `antialiased` filters (premultiplied). */
  edges: "antialiased" | "crisp";
  /** Alpha at or above which a pixel counts for the baseline. Default 128. */
  measureThreshold?: number;
  /** Pixels kept free inside the frame edge when fitting the common scale. Default 1. */
  margin?: number;
  /**
   * For each figure, the family it belongs to (any key). Within a family each figure's scale is
   * normalised to the family's median sqrt(area), the correction clamped to `clamp`. Omit to
   * register without normalisation.
   */
  families?: string[];
  /** Bounds of the per-figure normalisation factor. Default [0.8, 1.25]. */
  clamp?: [number, number];
  /** Use this common scale instead of fitting one. */
  scale?: number;
}

export interface RegisteredFrame {
  /** RGBA, exactly frame.width x frame.height. */
  image: Raster;
  /** Measured on `image`. */
  measure: FrameMeasure;
  /** Largest of |baseline - anchor.y| and |centerX - (anchor.x + 0.5)| (a pixel's centre is x + 0.5), in px. */
  jitterPx: number;
  /** The scale and normalisation applied, and the placement, for provenance. */
  transforms: Transform[];
}

export interface Registration {
  frames: RegisteredFrame[];
  /** The common scale (source px → frame px) before per-figure normalisation. */
  scale: number;
  /** The largest jitterPx over the frames. */
  jitterPx: number;
}

/** One proposed or confirmed animation family. */
export interface FamilyGroup {
  /** For example "idle" or "walk-right"; becomes the spec's animationFamily. */
  name: string;
  /** Frame numbers in play order. Ignored (may be omitted) when `mirrorOf` is set. */
  frames?: number[];
  /** This family is the horizontal mirror of the named family's frames, in the same order. */
  mirrorOf?: string;
  /** Why the frames belong together, in this order. */
  reason: string;
}

/**
 * The grouping file. The vision model's proposal is written with `status: "proposed"`; only the
 * author sets `"confirmed"`, after editing families, order, mirrors and frames. Nothing written
 * into a target comes from a grouping that is not confirmed.
 */
export interface Grouping {
  status: "proposed" | "confirmed";
  families: FamilyGroup[];
  /** Frames the proposal left out of every family. */
  unassigned: number[];
  notes?: string;
  /** The model call that proposed it, when one did. */
  proposedBy?: { model: string; requestId: string };
}
