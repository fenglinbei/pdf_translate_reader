import type { CSSProperties } from "react";
import type { SentenceSelection } from "../types/domain";

export type TranslationCardPlacement = "above" | "below" | "left" | "right";
export type TranslationFavoriteAction = "add" | "remove";

export type FloatingTranslationCardView = {
  dragOffset: {
    x: number;
    y: number;
  };
  size?: {
    height: number;
    width: number;
  };
};

export type TranslationCardViewChange = Partial<FloatingTranslationCardView>;

export type TranslationCardPinInput = {
  placement: TranslationCardPlacement;
  selection: SentenceSelection;
  style: CSSProperties;
  view: FloatingTranslationCardView;
};

export type PinnedTranslationCard = TranslationCardPinInput & {
  key: string;
  zIndex: number;
};

export type StoredPinnedTranslationCard = PinnedTranslationCard & {
  createdAt: number;
  pdfFingerprint: string;
  updatedAt: number;
};
