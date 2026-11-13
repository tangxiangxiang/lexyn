import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { defaultWordbookFilters, type WordbookFilters } from '../../shared/contracts/wordbooks.ts'
import { prepareLibraryRestore } from '../../shared/backup/library.ts'
import { createReviewScheduler, schedulerConfigSnapshot } from '../../shared/srs/scheduler.ts'
import { initializeOwner } from '../auth/owner.ts'
import { openDatabase } from '../db/database.ts'
import { createLibraryService } from '../study/library.ts'
import { createStudyStore } from '../study/store.ts'
import { installBuiltinBook, previewBuiltinBook } from '../study/wordbooks.ts'
import { importCefr } from './classification.ts'
import { createEcdict } from './ecdict.ts'
import { importEcdictCsv } from './import.ts'

test('preserves source versions and conflicting levels, filters by Word and installs the verified selection atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lexyn-wordbooks-'))
  const db = openDatabase(dir)
  const dictionary = createEcdict(dir)
  try {
    await initializeOwner(db, 'test-admin', 'test-owner-password')
    const owner = db.prepare('SELECT id FROM owner').pluck().get() as string
    const store = createStudyStore(db, owner)
    const now = Date.UTC(2026, 9, 2)
    const config = schedulerConfigSnapshot(await createReviewScheduler())
    const library = createLibraryService(store, config)
    const tags = ['cet4', 'gk'] as const
    const preview = (filters: Partial<WordbookFilters> = {}, offset = 0, limit = 20) =>
      previewBuiltinBook(store, dictionary, now, 'cet4', [...tags], { ...defaultWordbookFilters, ...filters }, offset, limit)
    expect(preview()).toMatchObject({ installed: false, count: 0, cefrAvailable: false })
    const file = join(dir, 'sample.csv')
    writeFileSync(file, [
      'word,phonetic,definition,translation,pos,tag,bnc,frq,exchange,collins,oxford',
      'Signal,,,,n,cet4,40,7,,4,1',
      'signal,ˈsɪɡnəl,,信号,n,cet4 gk,40,7,,4,1',
      'Thread,,,线,n,cet4,4,17,,2,',
      'thread,,,线程,n,cet4,4,17,,2,',
      'US,,,美国,n,cet4,0,-1,,0,',
      'us,,,我们,n,cet4,bad,1,,6,',
      'albatross,,,信天翁,n,toefl,3,9,,5,1',
    ].join('\n'))
    const { sha256 } = await importEcdictCsv(dir, file, 'fixture-1')
    writeFileSync(file, 'headword,pos,CEFR\nsignal,noun,A2\nsignal,verb,B1\nthread,noun,B2\n')
    importCefr(dir, file, 'cefr-j', '1.5-fixture')
    writeFileSync(file, 'headword,pos,CEFR\nsignal,noun,C1\n')
    importCefr(dir, file, 'octanove', '1.0-fixture')
    const initial = preview()
    expect(initial.count).toBe(4)
    expect(initial.sources[0]).toMatchObject({ sha256, version: 'fixture-1' })
    expect(initial.entries.find(({ word }) => word === 'signal')?.classifications).toEqual([
      expect.objectContaining({ source: 'ECDICT', collins: 4, bncRank: 40, frqRank: 7, oxfordCore: true }),
      expect.objectContaining({ source: 'CEFR-J Vocabulary Profile', cefr: 'A2', version: '1.5-fixture' }),
      expect.objectContaining({ source: 'CEFR-J Vocabulary Profile', cefr: 'B1' }),
      expect.objectContaining({ source: 'Octanove Vocabulary Profile', cefr: 'C1' }),
    ])
    expect(initial.entries.find(({ word }) => word === 'US')?.classifications[0]).toMatchObject({
      collins: undefined, bncRank: undefined, frqRank: undefined,
    })
    expect(preview({ cefr: ['A2', 'B2'], collins: [4, 5] }).entries.map(({ word }) => word)).toEqual(['signal'])
    expect(preview({ cefr: ['unknown'] }).entries.map(({ word }) => word)).toEqual(['us', 'US'])
    expect(preview({ order: 'frq-common' }, 1, 2).entries.map(({ word }) => word)).toEqual(['signal', 'thread'])
    expect(preview({ order: 'bnc-rare' }).entries.map(({ word }) => word)).toEqual(['signal', 'thread', 'us', 'US'])
    expect(dictionary.wordbooks().books.find(({ id }) => id === 'senior-high')).toMatchObject({ available: false, count: 0 })
    expect(store.progress()).toEqual([])

    writeFileSync(file, 'headword,pos,CEFR\nsignal,noun,B2\n')
    importCefr(dir, file, 'cefr-j', '1.5-revised')
    dictionary.close()
    expect(preview().selection).not.toBe(initial.selection)
    expect(preview({ cefr: ['A2'] }).count).toBe(0)
    expect(preview({ cefr: ['C1'] }).count).toBe(1)

    const personal = library.createDeck({ name: 'Personal' }, now)
    const signal = library.createEntry(personal.id, { term: 'signal', meaning: '个人释义' }, now)
    const session = randomUUID()
    store.addPractice({ id: randomUUID(), deckId: personal.id, entryId: signal.id, sessionId: session,
      mode: 'copy', outcome: 'completed', startedAt: now, completedAt: now, attempts: 1, assisted: false, firstTryCorrect: true })
    store.saveProgress({ entryId: signal.id, firstCompletedAt: now, lastPracticedAt: now, completedCount: 1 })
    store.saveWordProgress({ wordId: signal.wordId!, firstCompletedAt: now, lastPracticedAt: now, completedCount: 1 })
    const pending = preview({ states: ['unlearned'] })
    expect(pending.count).toBe(3)
    expect(preview({ states: ['learned'] }).learned).toBe(1)
    const latest = preview()
    const install = (selection: string) => store.request(randomUUID(), selection, () =>
      installBuiltinBook(store, config, dictionary, now, 'cet4', [...tags], defaultWordbookFilters, 2, selection))
    expect(() => install(initial.selection)).toThrow('preview changed')
    db.exec(`CREATE TEMP TRIGGER interrupt_install BEFORE INSERT ON entries
      WHEN NEW.active_term='us' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
    expect(() => install(latest.selection)).toThrow('fixture failure')
    expect(store.decks().map(({ id }) => id)).toEqual([personal.id])
    expect(store.entries()).toHaveLength(1)
    db.exec('DROP TRIGGER interrupt_install')

    const result = install(latest.selection)
    expect(result.count).toBe(latest.count)
    expect(install(latest.selection)).toMatchObject({ alreadyAdded: true, deck: { id: result.deck.id } })
    const lists = store.lists.summaries(result.deck.id)
    expect(lists.map(({ count, learned }) => [count, learned])).toEqual([[2, 1], [2, 0]])
    const entries = lists.flatMap(({ id }) => store.lists.entries(result.deck.id, id))
    expect(entries.map(({ term }) => term)).toEqual(['signal', 'thread', 'us', 'US'])
    expect(entries[0]).toMatchObject({ wordId: signal.wordId, meaning: '信号' })
    expect(store.entry(signal.id)?.meaning).toBe('个人释义')
    expect(store.activeCards()).toEqual([])
    expect(entries[2].wordId).not.toBe(entries[3].wordId)

    const backup = library.exportLibrary()
    const restored = await prepareLibraryRestore(JSON.stringify(backup))
    expect(restored.backup.decks.find(({ id }) => id === result.deck.id)?.builtin).toEqual(result.deck.builtin)
    expect(restored.backup.entries).toHaveLength(5)
  } finally {
    dictionary.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
