// Convert the GitHub-flavored Markdown the agent emits into the lightweight
// formatting WhatsApp actually renders, so posts show native bold/italic
// instead of literal **, ##, [](), etc. The mirror of slack-format.js for the
// WhatsApp channel.
//
// WhatsApp's dialect:
//   - bold is *single-asterisk*, not **double**
//   - italic is _underscore_ (same as Markdown emphasis — leave alone)
//   - strikethrough is ~one tilde~, not ~~two~~
//   - monospace is ```triple-backtick``` (code is passed through verbatim)
//   - there are no #/##/### headers, and no [text](url) inline links
//
// Deliberately conservative, exactly like slack-format.js: code (inline +
// fenced) is split out and passed through verbatim, numbered lists and
// blockquotes are left alone, and single-* (already bold) / _italic_ (already
// supported) are not touched — so we never mangle what already works. The only
// divergence from the Slack version is links: WhatsApp has no link syntax, so
// [text](url) collapses to "text (url)" rather than Slack's <url|text>.

function transformProse(s) {
  let out = s
  // Links: [text](url) -> text (url)  (WhatsApp has no inline-link syntax)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `${t} (${u})`)
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

export function toWhatsappText(md) {
  if (!md || typeof md !== 'string') return md
  // Split on code spans/blocks. With a capturing group, split() interleaves the
  // delimiters into the array at odd indices — so even segments are prose to
  // transform, odd segments are code to keep verbatim.
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  return parts.map((seg, i) => (i % 2 === 1 ? seg : transformProse(seg))).join('')
}
