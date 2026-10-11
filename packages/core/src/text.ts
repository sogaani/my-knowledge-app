/** Decode a text file that may be UTF-8 or CP932 (楽天証券 CSV exports are Shift_JIS). Strips a UTF-8 BOM. */
export function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}
