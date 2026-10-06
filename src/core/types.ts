export type StepType =
  | "push"
  | "blocked-pop"
  | "equal-merge"
  | "zero-barrier"
  | "final-pop";

export interface StackStep {
  seq: number;
  type: StepType;
  index: number;
  reason: string;
  incomingHeight: string;
  poppedHeight?: string;
  candidateLeft?: number;
  interval?: [number, number];
  area?: string;
  bestUpdated: boolean;
  stackAfter: Array<{ height: string; left: number }>;
}

export interface RectangleResult {
  hasPositiveRectangle: boolean;
  left: number | null;
  right: number | null;
  width: number | null;
  height: string | null;
  area: string;
}

export interface AnalysisResult {
  heights: string[];
  result: RectangleResult;
  steps: StackStep[];
  minimumPositions: number[];
}

export interface ServiceError {
  error: string;
  code: string;
  message: string;
}
