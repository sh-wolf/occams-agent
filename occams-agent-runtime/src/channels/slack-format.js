// Convert the GitHub-flavored Markdown the agent emits into Slack *mrkdwn* so
// posts render natively instead of showing literal **, ##, [](), etc.
//
// Slack's dialect differs from standard Markdown:
//   - bold is *single-asterisk*, not **double**
//   - links are <url|text>, not [text](url)
//   - there are no #/##/### headers in message text
//   - strikethrough is ~one tilde~, not ~~two~~
//
// Deliberately conservative: code (inline + fenced) is split out and passed
// through verbatim, numbered lists and blockquotes are left alone, and single-*
// (already bold in Slack) and _italic_ (already supported) are not touched — so
// we never mangle what already works.

function transformProse(s) {
  let out = s
  // Links: [text](url) -> <url|text>
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<${u}|${t}>`)
  // Bold: **text** / __text__ -> *text*  (guard against empty/space-only bodies)
  out = out.replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, '*$1*')
  out = out.replace(/__(?!\s)([^_]+?)(?<!\s)__/g, '*$1*')
  // Strikethrough: ~~text~~ -> ~text~
  out = out.replace(/~~(?!\s)([^~]+?)(?<!\s)~~/g, '~$1~')
  // Headers: a leading #..###### becomes a bold line.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*')
  // Bullets: leading "-", "*", or "+" markers -> "• "
  out = out.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
  return out
}

export function toSlackMrkdwn(md) {
  if (!md || typeof md !== 'string') return md
  // Split on code spans/blocks. With a capturing group, split() interleaves the
  // delimiters into the array at odd indices — so even segments are prose to
  // transform, odd segments are code to keep verbatim.
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  return parts.map((seg, i) => (i % 2 === 1 ? seg : transformProse(seg))).join('')
}
