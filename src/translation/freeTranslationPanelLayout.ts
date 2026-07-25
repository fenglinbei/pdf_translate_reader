import type {
  FreeTranslationPanelMode,
  ReaderSession,
} from "../app/readerSessionRepository";

export type FreeTranslationPanelBounds = {
  height: number;
  left: number;
  top: number;
  width: number;
};

export type FreeTranslationPanelSize = Pick<
  FreeTranslationPanelBounds,
  "height" | "width"
>;

export type FreeTranslationViewport = {
  height: number;
  left: number;
  layoutWidth: number;
  top: number;
  width: number;
};

export const FREE_TRANSLATION_DESKTOP_BREAKPOINT = 920;
export const FREE_TRANSLATION_PANEL_GUTTER = 16;
export const FREE_TRANSLATION_PANEL_MIN_HEIGHT = 600;
export const FREE_TRANSLATION_PANEL_MIN_WIDTH = 880;
export const FREE_TRANSLATION_SOURCE_RATIO_DEFAULT = 50;
export const FREE_TRANSLATION_SOURCE_RATIO_MAX = 70;
export const FREE_TRANSLATION_SOURCE_RATIO_MIN = 30;

const PANEL_PRESET_SIZES: Record<
  Exclude<FreeTranslationPanelMode, "custom">,
  FreeTranslationPanelSize
> = {
  standard: {
    height: 820,
    width: 1_240,
  },
  wide: {
    height: 960,
    width: 1_600,
  },
};

export function getFreeTranslationViewport(): FreeTranslationViewport {
  if (typeof window === "undefined") {
    return {
      height: 900,
      left: 0,
      layoutWidth: 1_440,
      top: 0,
      width: 1_440,
    };
  }

  const visualViewport = window.visualViewport;

  return {
    height: visualViewport?.height ?? window.innerHeight,
    left: visualViewport?.offsetLeft ?? 0,
    layoutWidth: window.innerWidth,
    top: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
  };
}

export function isFreeTranslationDesktopViewport(
  viewport: FreeTranslationViewport,
) {
  return viewport.layoutWidth > FREE_TRANSLATION_DESKTOP_BREAKPOINT;
}

export function getInitialFreeTranslationLayout(
  session: ReaderSession | undefined,
  viewport: FreeTranslationViewport,
) {
  const mode = session?.freeTranslationPanelMode ?? "wide";
  const preferredSize = mode === "custom"
    ? normalizeCustomPanelSize(
      {
        height: session?.freeTranslationPanelHeight,
        width: session?.freeTranslationPanelWidth,
      },
      PANEL_PRESET_SIZES.wide,
    )
    : PANEL_PRESET_SIZES[mode];

  return {
    bounds: createCenteredFreeTranslationBounds(preferredSize, viewport),
    mode,
    preferredSize,
    sourceRatio: clampFreeTranslationSourceRatio(
      session?.freeTranslationSourceRatio ??
        FREE_TRANSLATION_SOURCE_RATIO_DEFAULT,
    ),
  };
}

export function getFreeTranslationPresetSize(
  mode: Exclude<FreeTranslationPanelMode, "custom">,
) {
  return PANEL_PRESET_SIZES[mode];
}

export function createCenteredFreeTranslationBounds(
  requestedSize: FreeTranslationPanelSize,
  viewport: FreeTranslationViewport,
): FreeTranslationPanelBounds {
  const size = clampFreeTranslationPanelSize(requestedSize, viewport);

  return {
    ...size,
    left: viewport.left + Math.max(
      FREE_TRANSLATION_PANEL_GUTTER,
      Math.round((viewport.width - size.width) / 2),
    ),
    top: viewport.top + Math.max(
      FREE_TRANSLATION_PANEL_GUTTER,
      Math.round((viewport.height - size.height) / 2),
    ),
  };
}

export function createMaximizedFreeTranslationBounds(
  viewport: FreeTranslationViewport,
): FreeTranslationPanelBounds {
  return {
    height: Math.max(0, viewport.height - FREE_TRANSLATION_PANEL_GUTTER * 2),
    left: viewport.left + FREE_TRANSLATION_PANEL_GUTTER,
    top: viewport.top + FREE_TRANSLATION_PANEL_GUTTER,
    width: Math.max(0, viewport.width - FREE_TRANSLATION_PANEL_GUTTER * 2),
  };
}

export function resizeFreeTranslationBounds(
  startBounds: FreeTranslationPanelBounds,
  delta: {
    x: number;
    y: number;
  },
  viewport: FreeTranslationViewport,
): FreeTranslationPanelBounds {
  const availableWidth = Math.max(
    0,
    viewport.left + viewport.width -
      FREE_TRANSLATION_PANEL_GUTTER -
      startBounds.left,
  );
  const availableHeight = Math.max(
    0,
    viewport.top + viewport.height -
      FREE_TRANSLATION_PANEL_GUTTER -
      startBounds.top,
  );
  const minimumWidth = Math.min(
    FREE_TRANSLATION_PANEL_MIN_WIDTH,
    availableWidth,
  );
  const minimumHeight = Math.min(
    FREE_TRANSLATION_PANEL_MIN_HEIGHT,
    availableHeight,
  );

  return {
    ...startBounds,
    height: clamp(
      Math.round(startBounds.height + delta.y),
      minimumHeight,
      availableHeight,
    ),
    width: clamp(
      Math.round(startBounds.width + delta.x),
      minimumWidth,
      availableWidth,
    ),
  };
}

export function clampFreeTranslationPanelBounds(
  bounds: FreeTranslationPanelBounds,
  viewport: FreeTranslationViewport,
) {
  const size = clampFreeTranslationPanelSize(bounds, viewport);
  const maximumLeft = Math.max(
    viewport.left + FREE_TRANSLATION_PANEL_GUTTER,
    viewport.left + viewport.width -
      FREE_TRANSLATION_PANEL_GUTTER -
      size.width,
  );
  const maximumTop = Math.max(
    viewport.top + FREE_TRANSLATION_PANEL_GUTTER,
    viewport.top + viewport.height -
      FREE_TRANSLATION_PANEL_GUTTER -
      size.height,
  );

  return {
    ...size,
    left: clamp(
      Math.round(bounds.left),
      viewport.left + FREE_TRANSLATION_PANEL_GUTTER,
      maximumLeft,
    ),
    top: clamp(
      Math.round(bounds.top),
      viewport.top + FREE_TRANSLATION_PANEL_GUTTER,
      maximumTop,
    ),
  };
}

export function clampFreeTranslationSourceRatio(value: number) {
  return clamp(
    Number.isFinite(value) ? Math.round(value) : FREE_TRANSLATION_SOURCE_RATIO_DEFAULT,
    FREE_TRANSLATION_SOURCE_RATIO_MIN,
    FREE_TRANSLATION_SOURCE_RATIO_MAX,
  );
}

function clampFreeTranslationPanelSize(
  requestedSize: FreeTranslationPanelSize,
  viewport: FreeTranslationViewport,
) {
  const availableWidth = Math.max(
    0,
    viewport.width - FREE_TRANSLATION_PANEL_GUTTER * 2,
  );
  const availableHeight = Math.max(
    0,
    viewport.height - FREE_TRANSLATION_PANEL_GUTTER * 2,
  );
  const minimumWidth = Math.min(
    FREE_TRANSLATION_PANEL_MIN_WIDTH,
    availableWidth,
  );
  const minimumHeight = Math.min(
    FREE_TRANSLATION_PANEL_MIN_HEIGHT,
    availableHeight,
  );

  return {
    height: clamp(
      Number.isFinite(requestedSize.height)
        ? Math.round(requestedSize.height)
        : PANEL_PRESET_SIZES.wide.height,
      minimumHeight,
      availableHeight,
    ),
    width: clamp(
      Number.isFinite(requestedSize.width)
        ? Math.round(requestedSize.width)
        : PANEL_PRESET_SIZES.wide.width,
      minimumWidth,
      availableWidth,
    ),
  };
}

function normalizeCustomPanelSize(
  size: {
    height: number | undefined;
    width: number | undefined;
  },
  fallback: FreeTranslationPanelSize,
) {
  return {
    height: size.height ?? fallback.height,
    width: size.width ?? fallback.width,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
