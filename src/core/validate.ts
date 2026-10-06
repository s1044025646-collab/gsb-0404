import { MAX_BAR_COUNT, MAX_HEIGHT_DIGITS } from "./limits.js";

export function validateHeights(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ValidationError("INVALID_INPUT", "柱高必须是数组。");
  }
  if (input.length > MAX_BAR_COUNT) {
    throw new ValidationError("INPUT_TOO_LARGE", `柱数不能超过 ${MAX_BAR_COUNT}。`);
  }

  return input.map((value, index) => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ValidationError(
          "INVALID_HEIGHT",
          `第 ${index} 项必须是非负安全整数，或使用十进制字符串。`,
        );
      }
      return value.toString();
    }

    if (typeof value !== "string") {
      throw new ValidationError("INVALID_HEIGHT", `第 ${index} 项必须是十进制字符串。`);
    }

    const text = value.trim();
    if (!/^\d+$/.test(text)) {
      throw new ValidationError("INVALID_HEIGHT", `第 ${index} 项不是非负十进制整数。`);
    }
    if (text.replace(/^0+/, "").length > MAX_HEIGHT_DIGITS) {
      throw new ValidationError("INVALID_HEIGHT", `第 ${index} 项位数不能超过 ${MAX_HEIGHT_DIGITS}。`);
    }
    if (/^0+$/.test(text)) return "0";
    const normalized = text.replace(/^0+(?=\d)/, "");
    if (normalized.replace(/^0+/, "").length > MAX_HEIGHT_DIGITS) {
      throw new ValidationError("INVALID_HEIGHT", `第 ${index} 项位数不能超过 ${MAX_HEIGHT_DIGITS}。`);
    }
    return normalized;
  });
}

export class ValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}
