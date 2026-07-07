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
const ACTION_POPOVER_GAP = 6;
const ACTION_POPOVER_ESTIMATED_HEIGHT = 58;
const ACTION_POPOVER_MAX_WIDTH = 380;
const ACTION_POPOVER_MIN_WIDTH = 320;
const ACTION_POPOVER_MIN_HEIGHT = 44;
// When placing the popover on a side gutter (outside the page), require the
// selection to be within this many pixels of that side, otherwise the popover
// ends up far from the selected text.
const OUTSIDE_ANCHOR_PROXIMITY = 120;

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
  const widthStyle = {
    "--translation-popover-width": `${insidePopoverWidth}px`,
  } as CSSProperties;
  const anchorCenterX = anchor.left + anchor.width / 2;
  const preferredInsideSide: "left" | "right" = anchorCenterX < pageSize.width / 2 ? "right" : "left";

  // 1. Prefer placing directly below the selection (close and unambiguous).
  const belowTop = anchor.bottom + POPOVER_GAP;
  const hasBelowRoom = belowTop + POPOVER_MIN_HEIGHT <= pageSize.height - PAGE_MARGIN;
  const belowLeft = clamp(
    anchor.left,
    PAGE_MARGIN,
    Math.max(PAGE_MARGIN, pageSize.width - PAGE_MARGIN - insidePopoverWidth),
  );
  if (hasBelowRoom) {
    return {
      placement: "below",
      style: {
        ...widthStyle,
        left: belowLeft,
        top: Math.min(belowTop, pageSize.height - PAGE_MARGIN - POPOVER_MIN_HEIGHT),
      },
    };
  }

  // 2. Then above the selection.
  const hasAboveRoom = anchor.top - POPOVER_GAP - POPOVER_MIN_HEIGHT >= PAGE_MARGIN;
  if (hasAboveRoom) {
    return {
      placement: "above",
      style: {
        ...widthStyle,
        bottom: pageSize.height - anchor.top + POPOVER_GAP,
        left: belowLeft,
      },
    };
  }

  // 3. Inside-page side placement, vertically centered on the selection.
  const rightSpace = pageSize.width - PAGE_MARGIN - anchor.right - POPOVER_GAP;
  const leftSpace = anchor.left - PAGE_MARGIN - POPOVER_GAP;
  const sideThreshold = Math.min(260, insidePopoverWidth);
  const sideTop = getSideTop(anchor, POPOVER_ESTIMATED_HEIGHT, pageSize.height);

  if (preferredInsideSide === "right" && rightSpace >= sideThreshold) {
    return {
      placement: "right",
      style: {
        ...widthStyle,
        left: clamp(anchor.right + POPOVER_GAP, PAGE_MARGIN, pageSize.width - PAGE_MARGIN - insidePopoverWidth),
        top: sideTop,
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
        top: sideTop,
      },
    };
  }

  if (rightSpace >= sideThreshold) {
    return {
      placement: "right",
      style: {
        ...widthStyle,
        left: clamp(anchor.right + POPOVER_GAP, PAGE_MARGIN, pageSize.width - PAGE_MARGIN - insidePopoverWidth),
        top: sideTop,
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
        top: sideTop,
      },
    };
  }

  // 4. Outside the page in the gutter, but only when the selection is near
  // that side so the popover stays close to the text.
  const preferredOutsideSide: "left" | "right" = anchorCenterX >= pageSize.width / 2 ? "right" : "left";
  const outsideRight = isAnchorNearSide(anchor, "right", pageSize.width)
    ? getOutsidePlacement("right", pageSize.gutters.right, anchor, pageSize)
    : undefined;
  const outsideLeft = isAnchorNearSide(anchor, "left", pageSize.width)
    ? getOutsidePlacement("left", pageSize.gutters.left, anchor, pageSize)
    : undefined;

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

  // 5. Fallback: below (clamped) then above.
  if (hasBelowRoom || anchor.top < pageSize.height / 2) {
    return {
      placement: "below",
      style: {
        ...widthStyle,
        left: belowLeft,
        top: Math.min(belowTop, pageSize.height - PAGE_MARGIN - POPOVER_MIN_HEIGHT),
      },
    };
  }

  return {
    placement: "above",
    style: {
      ...widthStyle,
      bottom: pageSize.height - anchor.top + POPOVER_GAP,
      left: belowLeft,
    },
  };
}

export function getActionPopoverPlacement(
  anchor: SelectionBounds,
  pageSize: { gutters: PageGutters; height: number; width: number },
): {
  placement: "above" | "below" | "left" | "right";
  style: CSSProperties;
} {
  const popoverWidth = getActionPopoverWidth(pageSize.width - PAGE_MARGIN * 2);
  const widthStyle = {
    "--selection-action-popover-width": `${popoverWidth}px`,
  } as CSSProperties;
  const anchorCenterX = anchor.left + anchor.width / 2;
  const preferredInsideSide: "left" | "right" = anchorCenterX < pageSize.width / 2 ? "right" : "left";
  const horizontalLeft = clamp(
    anchor.left,
    PAGE_MARGIN,
    Math.max(PAGE_MARGIN, pageSize.width - PAGE_MARGIN - popoverWidth),
  );

  // 1. Prefer above the selection (keeps the action bar pinned to the text).
  const hasAboveRoom = anchor.top - ACTION_POPOVER_GAP - ACTION_POPOVER_MIN_HEIGHT >= PAGE_MARGIN;
  if (hasAboveRoom) {
    return {
      placement: "above",
      style: {
        ...widthStyle,
        bottom: pageSize.height - anchor.top + ACTION_POPOVER_GAP,
        left: horizontalLeft,
      },
    };
  }

  // 2. Then below the selection.
  const belowTop = anchor.bottom + ACTION_POPOVER_GAP;
  const hasBelowRoom = belowTop + ACTION_POPOVER_MIN_HEIGHT <= pageSize.height - PAGE_MARGIN;
  if (hasBelowRoom) {
    return {
      placement: "below",
      style: {
        ...widthStyle,
        left: horizontalLeft,
        top: belowTop,
      },
    };
  }

  // 3. Inside-page side placement, vertically centered on the selection.
  const sideThreshold = Math.min(ACTION_POPOVER_MIN_WIDTH, popoverWidth);
  const rightSpace = pageSize.width - PAGE_MARGIN - anchor.right - ACTION_POPOVER_GAP;
  const leftSpace = anchor.left - PAGE_MARGIN - ACTION_POPOVER_GAP;
  const sideTop = getSideTop(anchor, ACTION_POPOVER_ESTIMATED_HEIGHT, pageSize.height);

  if (preferredInsideSide === "right" && rightSpace >= sideThreshold) {
    return {
      placement: "right",
      style: {
        ...widthStyle,
        left: clamp(anchor.right + ACTION_POPOVER_GAP, PAGE_MARGIN, pageSize.width - PAGE_MARGIN - popoverWidth),
        top: sideTop,
      },
    };
  }

  if (preferredInsideSide === "left" && leftSpace >= sideThreshold) {
    return {
      placement: "left",
      style: {
        ...widthStyle,
        left: clamp(
          anchor.left - ACTION_POPOVER_GAP - popoverWidth,
          PAGE_MARGIN,
          pageSize.width - PAGE_MARGIN - popoverWidth,
        ),
        top: sideTop,
      },
    };
  }

  if (rightSpace >= sideThreshold) {
    return {
      placement: "right",
      style: {
        ...widthStyle,
        left: clamp(anchor.right + ACTION_POPOVER_GAP, PAGE_MARGIN, pageSize.width - PAGE_MARGIN - popoverWidth),
        top: sideTop,
      },
    };
  }

  if (leftSpace >= sideThreshold) {
    return {
      placement: "left",
      style: {
        ...widthStyle,
        left: clamp(
          anchor.left - ACTION_POPOVER_GAP - popoverWidth,
          PAGE_MARGIN,
          pageSize.width - PAGE_MARGIN - popoverWidth,
        ),
        top: sideTop,
      },
    };
  }

  // 4. Outside gutter, only when the selection is close to that side.
  const preferredOutsideSide: "left" | "right" = anchorCenterX >= pageSize.width / 2 ? "right" : "left";
  const outsideRight = isAnchorNearSide(anchor, "right", pageSize.width)
    ? getOutsideActionPlacement("right", pageSize.gutters.right, anchor, pageSize)
    : undefined;
  const outsideLeft = isAnchorNearSide(anchor, "left", pageSize.width)
    ? getOutsideActionPlacement("left", pageSize.gutters.left, anchor, pageSize)
    : undefined;

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

  // 5. Fallbacks.
  if (hasBelowRoom) {
    return {
      placement: "below",
      style: {
        ...widthStyle,
        left: horizontalLeft,
        top: belowTop,
      },
    };
  }

  return {
    placement: "above",
    style: {
      ...widthStyle,
      bottom: PAGE_MARGIN,
      left: horizontalLeft,
    },
  };
}

function isAnchorNearSide(anchor: SelectionBounds, side: "left" | "right", pageWidth: number) {
  if (side === "left") {
    return anchor.left <= OUTSIDE_ANCHOR_PROXIMITY;
  }

  return anchor.right >= pageWidth - OUTSIDE_ANCHOR_PROXIMITY;
}

function getOutsideActionPlacement(
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

  if (availableWidth < ACTION_POPOVER_MIN_WIDTH) {
    return undefined;
  }

  const popoverWidth = getActionPopoverWidth(availableWidth);
  const widthStyle = {
    "--selection-action-popover-width": `${popoverWidth}px`,
  } as CSSProperties;

  return {
    placement: side,
    style: {
      ...widthStyle,
      left: side === "right" ? pageSize.width + ACTION_POPOVER_GAP : -popoverWidth - ACTION_POPOVER_GAP,
      top: getSideTop(anchor, ACTION_POPOVER_ESTIMATED_HEIGHT, pageSize.height),
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

  return {
    placement: side,
    style: {
      ...widthStyle,
      left: side === "right" ? pageSize.width + POPOVER_GAP : -popoverWidth - POPOVER_GAP,
      top: getSideTop(anchor, POPOVER_ESTIMATED_HEIGHT, pageSize.height),
    },
  };
}

function getPopoverWidth(availableWidth: number) {
  return Math.min(POPOVER_MAX_WIDTH, Math.max(POPOVER_MIN_WIDTH, availableWidth));
}

function getActionPopoverWidth(availableWidth: number) {
  return Math.min(ACTION_POPOVER_MAX_WIDTH, Math.max(ACTION_POPOVER_MIN_WIDTH, availableWidth));
}

function getSideTop(anchor: SelectionBounds, estimatedHeight: number, pageHeight: number) {
  const anchorCenter = anchor.top + anchor.height / 2;

  return clamp(
    anchorCenter - estimatedHeight / 2,
    PAGE_MARGIN,
    Math.max(PAGE_MARGIN, pageHeight - PAGE_MARGIN - estimatedHeight),
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
