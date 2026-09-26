/**
 * Flags the habits a README and documentation are being rewritten out of.
 * Run from the root of a repository:
 *
 *   node prose.mjs              a table, one row per page (README.md and docs/**\/*.md)
 *   node prose.mjs <file> ...   every flagged line of those pages
 *
 * Heuristics, not a verdict. A dash, a "rather than" or a bold word is often
 * the right choice; what the table shows is where they pile up, which is where
 * a page reads like a pitch instead of a manual. Code blocks are skipped; the
 * front matter is not, because the home page's taglines are read first.
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

const CHECKS = [
  { key: 'dash', label: 'em dash', pattern: /—/g },
  {
    key: 'contrast',
    label: '"not X, but Y" / "rather than"',
    pattern: /\b(?:not|never)\b[^.\n]{0,50}(?:—|,)\s*(?:but|it is|it's|which)\b|\brather than\b/gi
  },
  {
    key: 'aphorism',
    label: 'closing line or moral',
    pattern:
      /\b(?:that is the point|the whole point|which is the point|is the price|there is no other way|needs no rule|nobody (?:notices|looks|reads)|every word|and says so|is the one that bites|is worse than none|goes stale)\b/gi
  },
  {
    key: 'persona',
    label: 'the app or a file as a person',
    pattern: /\b(?:lies|lying|honest(?:ly)?|dress(?:es|ed)? [^.]{0,30} up|tells? the truth|claims?)\b/gi
  },
  { key: 'bold', label: 'bold', pattern: /\*\*[^*\n]+\*\*/g }
]

const SKIP = new Set(['node_modules', 'public', 'dist', 'build', 'out'])

function pages() {
  const out = fs.existsSync(path.join(root, 'README.md')) ? ['README.md'] : []
  const walk = (dir) => {
    if (!fs.existsSync(path.join(root, dir))) return
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) walk(rel)
      else if (entry.name.endsWith('.md')) out.push(rel)
    }
  }
  walk('docs')
  if (out.length === 0) console.error('No README.md and no docs/ here: run this from the root of a repository, or name the files.')
  return out
}

/** The page's lines with fenced code blanked, so line numbers still match. */
function proseLines(file) {
  let inCode = false
  return fs
    .readFileSync(path.join(root, file), 'utf8')
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inCode = !inCode
        return ''
      }
      return inCode ? '' : line
    })
}

function count(lines) {
  const text = lines.join('\n')
  const words = (text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length
  const hits = Object.fromEntries(CHECKS.map((c) => [c.key, (text.match(c.pattern) ?? []).length]))
  return { words, hits }
}

const named = process.argv.slice(2)

if (named.length === 0) {
  const rows = pages().map((file) => ({ file, ...count(proseLines(file)) }))
  const per100 = (n, words) => (words === 0 ? 0 : (100 * n) / words)
  rows.sort((a, b) => per100(b.hits.dash, b.words) - per100(a.hits.dash, a.words))
  console.log(`${'page'.padEnd(34)} ${'words'.padStart(6)} ${'—/100w'.padStart(7)} ${'contr'.padStart(6)} ${'moral'.padStart(6)} ${'pers'.padStart(5)} ${'bold'.padStart(5)}`)
  const total = { words: 0, dash: 0, contrast: 0, aphorism: 0, persona: 0, bold: 0 }
  for (const { file, words, hits } of rows) {
    total.words += words
    for (const key of Object.keys(hits)) total[key] += hits[key]
    console.log(
      `${file.padEnd(34)} ${String(words).padStart(6)} ${per100(hits.dash, words).toFixed(2).padStart(7)} ${String(hits.contrast).padStart(6)} ${String(hits.aphorism).padStart(6)} ${String(hits.persona).padStart(5)} ${String(hits.bold).padStart(5)}`
    )
  }
  console.log(
    `\n${total.words} words: ${total.dash} em dashes (${per100(total.dash, total.words).toFixed(2)} per 100 words), ` +
      `${total.contrast} contrasts, ${total.aphorism} morals, ${total.persona} personifications, ${total.bold} bold`
  )
} else {
  for (const file of named) {
    const lines = proseLines(file)
    const { words, hits } = count(lines)
    console.log(`\n${file} — ${words} words`)
    lines.forEach((line, index) => {
      const found = CHECKS.filter((c) => line.match(c.pattern)).map((c) => c.label)
      if (found.length > 0) console.log(`  ${String(index + 1).padStart(4)}  [${found.join(', ')}]  ${line.trim().slice(0, 110)}`)
    })
    console.log(`  totals: ${JSON.stringify(hits)}`)
  }
}
