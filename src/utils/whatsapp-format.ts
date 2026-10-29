/**
 * Converts the Markdown that models tend to emit into WhatsApp's own formatting
 * (*bold*, _italic_, ~strike~, ```code```), so users never see stray "**" or "##".
 */
export function toWhatsAppFormat(text: string): string {
  // Keep fenced code blocks untouched.
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : convertSegment(part)))
    .join('');
}

function convertSegment(s: string): string {
  return s
    // Headings: "## Title" -> "*Title*"
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '*$1*')
    // Bold: **x** or __x__ -> *x*
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    // Strikethrough: ~~x~~ -> ~x~
    .replace(/~~(.+?)~~/g, '~$1~')
    // Links: [text](url) -> text (url)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    // Bullets: "- x" / "* x" -> "• x"
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    // Horizontal rules
    .replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '')
    // Collapse 3+ blank lines
    .replace(/\n{3,}/g, '\n\n');
}
