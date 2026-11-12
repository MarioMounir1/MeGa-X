/**
 * PROJECT MeGa X - ANSI Terminal Stream Parser & Color Utility
 */

export const ANSI_COLORS: Record<string, string> = {
  // Standard Foreground
  '30': '#484f58', // Black / Gray
  '31': '#f85149', // Red
  '32': '#3fb950', // Green
  '33': '#d29922', // Yellow
  '34': '#58a6ff', // Blue
  '35': '#bc8cff', // Magenta
  '36': '#39c5cf', // Cyan
  '37': '#b1bac4', // White

  // Bright Foreground
  '90': '#6e7681', // Bright Black
  '91': '#ff7b72', // Bright Red
  '92': '#56d364', // Bright Green
  '93': '#e3b341', // Bright Yellow
  '94': '#79c0ff', // Bright Blue
  '95': '#d2a8ff', // Bright Magenta
  '96': '#56d4dd', // Bright Cyan
  '97': '#f0f6fc', // Bright White
};

/**
 * Strips all ANSI escape codes from raw string.
 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Escapes raw text for HTML embedding.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Converts a raw string containing ANSI escape codes into safe styled HTML.
 */
export function ansiToHtml(raw: string): string {
  const sanitized = escapeHtml(raw);
  const regex = /\x1b\[([0-9;]*)m/g;

  let result = '';
  let lastIndex = 0;
  let activeColor: string | null = null;
  let isBold = false;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(sanitized)) !== null) {
    result += sanitized.slice(lastIndex, match.index);
    lastIndex = regex.lastIndex;

    const codes = match[1] ? match[1].split(';') : ['0'];
    for (const code of codes) {
      if (code === '0' || code === '') {
        // Reset
        if (activeColor || isBold) {
          result += '</span>';
          activeColor = null;
          isBold = false;
        }
      } else if (code === '1') {
        isBold = true;
      } else if (ANSI_COLORS[code]) {
        if (activeColor || isBold) {
          result += '</span>';
        }
        activeColor = ANSI_COLORS[code];
        result += `<span style="color:${activeColor};${isBold ? 'font-weight:bold;' : ''}">`;
      }
    }
  }

  result += sanitized.slice(lastIndex);
  if (activeColor || isBold) {
    result += '</span>';
  }

  return result;
}

/**
 * Wraps text with ANSI color escape code.
 */
export function colorize(
  text: string,
  color: 'red' | 'green' | 'yellow' | 'blue' | 'cyan' | 'magenta' | 'gray' | 'bold'
): string {
  const codes: Record<string, [number, number]> = {
    bold: [1, 22],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    gray: [90, 39],
  };

  const pair = codes[color] ?? [0, 0];
  return `\x1b[${pair[0]}m${text}\x1b[${pair[1]}m`;
}

