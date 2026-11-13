import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { builtinWordbookById, builtinWordbookTags, type BuiltinWordbookId, type BuiltinWordbookTag } from '../../shared/domain/builtin-books.ts'
import { cleanDictionaryReference } from '../../shared/domain/dictionary.ts'
import { wordKey } from '../../shared/domain/word.ts'
import type { DictionaryEntry } from '../../shared/contracts/dictionary.ts'
import type { VocabularySource, WordbookFilters, WordClassification } from '../../shared/contracts/wordbooks.ts'

const tags = builtinWordbookTags.map(({ id }) => id)
const tagBits = new Map<string, number>(tags.map((tag, i) => [tag, 1 << i]))
const mask = (values: readonly string[]) => values.reduce((result, tag) => result | (tagBits.get(tag) ?? 0), 0)
const rank = (value: string) => /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : null
const stars = (value: string) => /^[1-5]$/.test(value.trim()) ? Number(value) : null
const core = (value: string) => /^[01]$/.test(value.trim()) ? Number(value) : null

/** Index only usable rows with an actual exam tag. A legacy dictionary gets the same index in TEMP. */
export function buildWordbookIndex(db: Database.Database, legacy: boolean) {
  db.function('book_mask', { deterministic: true }, (value: string) => mask(value.toLowerCase().split(/\s+/)))
  db.function('book_variant', { deterministic: true }, (word: string) => wordKey(word).variant)
  db.function('book_rank', { deterministic: true }, rank)
  db.function('book_stars', { deterministic: true }, stars)
  db.function('book_core', { deterministic: true }, core)
  db.function('book_usable', { deterministic: true }, (word: string, translation: string, definition: string, pos: string, phonetic: string) => {
    if (!translation.trim()) return 0
    try {
      cleanDictionaryReference({ sourceWord: word, translation, definition, partOfSpeech: pos, phonetic: phonetic.trim() })
      return 1
    } catch { return 0 }
  })
  db.transaction(() => {
    db.exec(`
      CREATE ${legacy ? 'TEMP' : ''} TABLE wordbook_members (
        tag TEXT NOT NULL, word TEXT NOT NULL, normalized_term TEXT NOT NULL, variant TEXT NOT NULL, composition INTEGER NOT NULL,
        collins INTEGER, oxford INTEGER, bnc INTEGER, frq INTEGER, PRIMARY KEY(tag, normalized_term, variant, word)
      ) WITHOUT ROWID;
      WITH tagged AS MATERIALIZED (
        SELECT *, book_mask(tag) AS composition FROM dictionary_entries WHERE book_mask(tag)>0
      )
      INSERT INTO wordbook_members
      SELECT tag_set.tag, word, lookup_key, book_variant(word), composition,
        ${legacy ? 'NULL, NULL' : 'book_stars(collins), book_core(oxford)'}, book_rank(bnc), book_rank(frq)
      FROM tagged CROSS JOIN (${tags.map((tag, i) => `SELECT '${tag}' AS tag, ${1 << i} AS bit`).join(' UNION ALL ')}) tag_set
      WHERE (composition & bit)<>0 AND book_usable(word, translation, definition, pos, phonetic)=1;
      CREATE INDEX wordbook_member_word ON wordbook_members(tag, word);
      CREATE INDEX wordbook_collins ON wordbook_members(tag, collins);
    `)
  })()
}

interface WordState { normalizedTerm: string; variant: string; learned: number; due: number }
interface PreviewOptions {
  filters: WordbookFilters
  selectedTags: BuiltinWordbookTag[]
  offset: number
  limit: number
}
interface PreviewRow extends DictionaryEntry {
  learned: number
  due: number
  collins: number | null
  oxford: number | null
  bnc: number | null
  frq: number | null
}
interface CefrRow { name: string; version: string; level: NonNullable<WordClassification['cefr']> }

export function wordbookCounts(db: Database.Database) {
  return new Map((db.prepare(`
    SELECT tag, count(*) AS count FROM (SELECT DISTINCT tag, normalized_term, variant FROM wordbook_members) GROUP BY tag
  `).all() as { tag: string; count: number }[]).map(({ tag, count }) => [tag, count]))
}

export function queryWordbook(db: Database.Database, id: BuiltinWordbookId, options: PreviewOptions, states: WordState[],
  sources: VocabularySource[], withCefr: boolean, install = false) {
  const { filters, selectedTags, offset, limit } = options
  const tag = builtinWordbookById[id].tag
  const params = {
    tag: tag ?? '', mask: mask(selectedTags), offset, limit,
    cefr: JSON.stringify(filters.cefr.filter((level) => level !== 'unknown')),
    unknown: Number(filters.cefr.includes('unknown')), allCefr: Number(!filters.cefr.length),
    collins: JSON.stringify(filters.collins), allCollins: Number(!filters.collins.length),
    learned: Number(filters.states.includes('learned')), unlearned: Number(filters.states.includes('unlearned')),
    due: Number(filters.states.includes('due')), allStates: Number(!filters.states.length),
  }
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS wordbook_state (
    normalized_term TEXT, variant TEXT, learned INTEGER, due INTEGER, PRIMARY KEY(normalized_term, variant)
  ) WITHOUT ROWID; DELETE FROM wordbook_state`)
  const insertState = db.prepare('INSERT INTO wordbook_state VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    for (const row of states) insertState.run(row.normalizedTerm, row.variant, row.learned, row.due)
  })()
  try {
    const cefrMatch = withCefr
      ? `(@unknown=1 AND NOT EXISTS (SELECT 1 FROM classification.levels c WHERE c.normalized_term=m.normalized_term AND c.variant=m.variant))
         OR EXISTS (SELECT 1 FROM classification.levels c WHERE c.normalized_term=m.normalized_term AND c.variant=m.variant
           AND c.level IN (SELECT value FROM json_each(@cefr)))`
      : '@unknown=1'
    const cte = `WITH ranked AS (
      SELECT m.*, coalesce(s.learned,0) AS learned, coalesce(s.due,0) AS due,
        row_number() OVER (PARTITION BY m.normalized_term, m.variant
          ORDER BY (m.word<>m.normalized_term), m.word) AS row_no
      FROM wordbook_members m LEFT JOIN wordbook_state s USING (normalized_term, variant)
      WHERE m.tag=@tag AND (m.composition & @mask)<>0
        AND (@allCollins=1 OR m.collins IN (SELECT value FROM json_each(@collins)))
        AND (@allCefr=1 OR ${cefrMatch})
        AND (@allStates=1 OR (@learned=1 AND s.learned=1) OR (@unlearned=1 AND coalesce(s.learned,0)=0) OR (@due=1 AND s.due=1))
    )`
    const order = {
      alphabetical: '',
      'bnc-common': 'r.bnc IS NULL, r.bnc ASC, ', 'bnc-rare': 'r.bnc IS NULL, r.bnc DESC, ',
      'frq-common': 'r.frq IS NULL, r.frq ASC, ', 'frq-rare': 'r.frq IS NULL, r.frq DESC, ',
    }[filters.order] + 'r.normalized_term, r.variant, r.word'
    const members = db.prepare(`${cte} SELECT r.word, r.learned FROM ranked r WHERE row_no=1 ORDER BY ${order}`)
      .iterate(params) as Iterable<{ word: string; learned: number }>
    let count = 0
    const hash = createHash('sha256').update(JSON.stringify([id, sources.map(({ version, sha256 }) => [version, sha256])]))
    let learned = 0
    for (const member of members) {
      count++
      hash.update(JSON.stringify(member.word))
      learned += member.learned
    }
    const rows = db.prepare(`${cte}
      SELECT r.word, r.learned, r.due, r.collins, r.oxford, r.bnc, r.frq,
        d.phonetic, d.translation, d.definition, d.pos, d.tag
      FROM ranked r JOIN dictionary_entries d ON d.word=r.word WHERE row_no=1
      ORDER BY ${order} ${install ? '' : 'LIMIT @limit OFFSET @offset'}`).all(params) as PreviewRow[]
    const classification = new Map<string, CefrRow[]>()
    if (withCefr && !install && rows.length) {
      const matches = db.prepare(`
        SELECT r.word, s.name, s.version, l.level FROM json_each(?) AS input
        JOIN wordbook_members r ON r.tag=? AND r.word=input.value
        JOIN classification.levels l ON l.normalized_term=r.normalized_term AND l.variant=r.variant
        JOIN classification.sources s ON s.name=l.source
        ORDER BY r.word, s.name, l.level
      `).all(JSON.stringify(rows.map(({ word }) => word)), params.tag) as (CefrRow & { word: string })[]
      for (const { word, ...row } of matches) {
        const group = classification.get(word) ?? []
        group.push(row)
        classification.set(word, group)
      }
    }
    const source = sources[0]
    const entries = install ? [] : rows.map((row) => {
      const classifications: WordClassification[] = source ? [{
        source: source.name, version: source.version, collins: row.collins ?? undefined,
        oxfordCore: row.oxford === null ? undefined : row.oxford === 1, bncRank: row.bnc ?? undefined, frqRank: row.frq ?? undefined,
        tags: row.tag.trim().split(/\s+/),
      }] : []
      for (const { name, version, level } of classification.get(row.word) ?? []) {
        classifications.push({ source: name, version, cefr: level })
      }
      return { word: row.word, phonetic: row.phonetic, meaning: row.translation.replace(/\\n|\r?\n/g, ' ').trim().slice(0, 220),
        learned: !!row.learned, due: !!row.due, classifications }
    })
    const categories = db.prepare(`
      WITH words AS (SELECT normalized_term, variant,
        ${tags.map((tag) => `MAX((composition & ${mask([tag])})<>0) AS ${tag}`).join(', ')}
        FROM wordbook_members WHERE tag=? GROUP BY normalized_term, variant)
      SELECT ${tags.map((tag) => `coalesce(sum(${tag}),0) AS ${tag}`).join(', ')} FROM words
    `).get(params.tag) as Record<BuiltinWordbookTag, number>
    return {
      count, learned, selection: hash.digest('hex'), sources, entries,
      rows: install ? rows : [],
      categories: builtinWordbookTags.map(({ id, name }) => ({ id, name, count: categories[id], selected: selectedTags.includes(id) })),
      coverage: db.prepare(`
        SELECT coalesce(max(collins IS NOT NULL),0) AS collins, coalesce(max(bnc IS NOT NULL),0) AS bnc,
          coalesce(max(frq IS NOT NULL),0) AS frq FROM wordbook_members WHERE tag=?
      `).get(params.tag) as { collins: number; bnc: number; frq: number },
    }
  } finally {
    db.exec('DELETE FROM wordbook_state')
  }
}

export function emptyWordbook(selectedTags: BuiltinWordbookTag[]) {
  return { count: 0, learned: 0, selection: '', sources: [] as VocabularySource[],
    entries: [] as ReturnType<typeof queryWordbook>['entries'], coverage: { collins: 0, bnc: 0, frq: 0 },
    categories: builtinWordbookTags.map(({ id, name }) => ({ id, name, count: 0, selected: selectedTags.includes(id) })) }
}

export type { PreviewOptions, WordState }
