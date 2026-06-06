import type { CSSProperties } from "react";
import type { DOMRectLike } from "../types/domain";

export type SelectionBounds = Pick<DOMRectLike, "bottom" | "height" | "left" | "right" | "top" | "width">;
export type PageGutters = {
  left: number;
  right: number;
};

const PAGE_MARGIN = 12;
const POPOVER_GAP = 10;
const POPOVER_MAX_WIDTH = 340;
const POPOVER_MIN_WIDTH = 220;
const POPOVER_ESTIMATED_HEIGHT = 220;
const POPOVER_MIN_HEIGHT = 136;

export function getSelectionBounds(rects: DOMRectLike[]): SelectionBounds {
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  return {
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
  };
}

export function getPopoverPlacement(
  anchor: SelectionBounds,
  pageSize: { gutters: PageGutters; height: number; width: number },
): {
  placement: "above" | "below" | "left" | "right";
  style: CSSProperties;
} {
  const insidePopoverWidth = getPopoverWidth(pageSize.width - PAGE_MARGIN * 2);
  const preferredOutsideSide = anchor.left + anchor.width / 2 >= pageSize.width / 2 ? "right" : "left";
  const outsideRight = getOutsidePlacement("right", pageSize.gutters.right, anchor, pageSize);
  const outsideLeft = getOutsidePlacement("left", pageSize.gutters.left, anchor, pageSize);

  if (preferredOutsideSide === "right" && outsideRight) {
    return outsideRight;
  }

  if (preferredOutsideSide === "left" && outsideLeft) {
    return outsideLeft;
  }

  if (outsideRight) {
    return outsideRight;
  }

  if (outsideLeft) {
    return outsideLeft;
  }

  const sideThreshold = Math.min(260, insidePopoverWidth);
  const rightSpace = pageSize.width - PAGE_MARGIN - anchor.right - POPOVER_GAP;
  const leftSpace = anchor.left - PAGE_MARGIN - POPOVER_GAP;
  const top = clamp(
    anchor.top,
    PAGE_MARGIN,
    Math.max(PAGE_MARGIN, pageSize.height - PAGE_MARGIN - POPOVER_ESTIMATED_HEIGHT),
  );
  const widthStyle = {
    "--translation-popover-width": `${insidePopoverWidth}px`,
  } as CSSProperties;
  const preferredInsideSide = anchor.left + anchor.width / 2 < pageSize.width / 2 ? "right" : "left";

  if (preferredInsideSide === "right" && rightSpace >= sideThreshold) {
    return {
      placement: "right",
      style: {
        ...widthStyle,
        left: clamp(anchor.right + POPOVER_GAP, PAGE_MARGIN, pageSize.width - PAGE_MARGIN - insidePopoverWidth),
        top,
      },
    };
  }

  if (preferredInsideSide === "left" && leftSpace >= sideThreshold) {
    return {
      placement: "left",
      style: {
        ...widthStyle,
        left: clamp(
          anchor.left - POPOVER_GAP - insidePopoverWidth,
          PAGE_MARGIN,
          pageSize.width - PAGE_MARGIN - insidePopoverWidth,
        ),
        top,
      },
    };
  }

  if (rightSpace >= sideThreshold) {
    return {
      placement: "right",
      style: {
        ...widthStyle,
        left: clamp(anchor.right + POPOVER_GAP, PAGE_MARGIN, pageSize.width - PAGE_MARGIN - insidePopoverWidth),
        top,
      },
    };
  }

  if (leftSpace >= sideThreshold) {
    return {
      placement: "left",
      style: {
        ...widthStyle,
        left: clamp(
          anchor.left - POPOVER_GAP - insidePopoverWidth,
          PAGE_MARGIN,
          pageSize.width - PAGE_MARGIN - insidePopoverWidth,
        ),
        top,
      },
    };
  }

  const left = clamp(anchor.left, PAGE_MARGIN, pageSize.width - PAGE_MARGIN - insidePopoverWidth);
  const belowTop = anchor.bottom + POPOVER_GAP;
  const hasBelowRoom = belowTop + POPOVER_MIN_HEIGHT <= pageSize.height - PAGE_MARGIN;

  if (hasBelowRoom || anchor.top < pageSize.height / 2) {
    return {
      placement: "below",
      style: {
        ...widthStyle,
        left,
        top: Math.min(belowTop, pageSize.height - PAGE_MARGIN - POPOVER_MIN_HEIGHT),
      },
    };
  }

  return {
    placement: "above",
    style: {
      ...widthStyle,
      bottom: pageSize.height - anchor.top + POPOVER_GAP,
      left,
    },
  };
}

export function getActionPopoverPlacement(
  anchor: SelectionBounds,
  pageSize: { height: number; width: number },
): {
  placement: "above" | "below";
  style: CSSProperties;
} {
  const popoverWidth = getPopoverWidth(pageSize.width - PAGE_MARGIN * 2);
  const left = clamp(anchor.left, PAGE_MARGIN, pageSize.width - PAGE_MARGIN - popoverWidth);
  const belowTop = anchor.bottom + POPOVER_GAP;
  const hasBelowRoom = belowTop + POPOVER_MIN_HEIGHT <= pageSize.height - PAGE_MARGIN;
  const widthStyle = {
    "--translation-popover-width": `${popoverWidth}px`,
  } as CSSProperties;

  if (hasBelowRoom || anchor.top < pageSize.height / 2) {
    return {
      placement: "below",
      style: {
        ...widthStyle,
        left,
        top: Math.min(belowTop, pageSize.height - PAGE_MARGIN - POPOVER_MIN_HEIGHT),
      },
    };
  }

  return {
    placement: "above",
    style: {
      ...widthStyle,
      bottom: pageSize.height - anchor.top + POPOVER_GAP,
      left,
    },
  };
}

function getOutsidePlacement(
  side: "left" | "right",
  gutterWidth: number,
  anchor: SelectionBounds,
  pageSize: { height: number; width: number },
):
  | {
      placement: "left" | "right";
      style: CSSProperties;
    }
  | undefined {
  const availableWidth = gutterWidth - POPOVER_GAP - PAGE_MARGIN;

  if (availableWidth < POPOVER_MIN_WIDTH) {
    return undefined;
  }

  const popoverWidth = getPopoverWidth(availableWidth);
  const widthStyle = {
    "--translation-popover-width": `${popoverWidth}px`,
  } as CSSProperties;
  const top = clamp(
    anchor.top,
    PAGE_MARGIN,
    Math.max(PAGE_MARGIN, pageSize.height - PAGE_MARGIN - POPOVER_ESTIMATED_HEIGHT),
  );

  return {
    placement: side,
    style: {
      ...widthStyle,
      left: side === "right" ? pageSize.width + POPOVER_GAP : -popoverWidth - POPOVER_GAP,
      top,
    },
  };
}

function getPopoverWidth(availableWidth: number) {
  return Math.min(POPOVER_MAX_WIDTH, Math.max(POPOVER_MIN_WIDTH, availableWidth));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
