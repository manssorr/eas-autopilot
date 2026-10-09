export function strip(text) {
  return text
    .replace(/\x1b\[[0-9]*G|\x1b\[2K/g, "\r")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[78=>()]/g, "")
    .replace(/\x07/g, "");
}

// The question may continue on dim lines (eas-cli prints certificate details that way), so dim
// and reset sequences are allowed inside it. Use questionOf() to get the first line.
export const PROMPT_HEADER = /\x1b\[36m\?\x1b\[39m \x1b\[1m((?:[^\x1b]|\x1b\[(?!22m)[0-9;]*m)+?)\x1b\[22m([^\r\n]*)/g;

export function questionOf(group) {
  return strip(group).split(/[\r\n]+/)[0].trim();
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function visibleKeys(text) {
  return text
    .replace(/\x1b\[A/g, "↑")
    .replace(/\x1b\[B/g, "↓")
    .replace(/\x1b\[C/g, "→")
    .replace(/\x1b\[D/g, "←")
    .replace(/\r|\n/g, "⏎")
    .replace(/\x03/g, "^C")
    .replace(/\x7f/g, "⌫")
    .replace(/ /g, "␠");
}
