import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { listSizes, type Deck, type DeckList, type DeckListMember, type DeckListSummary, type Entry } from '../../shared/domain/library.ts'

const listColumns = 'id, deck_id AS deckId, name, list_order AS "order"'

function nextList(deckId: string, order: number): DeckList {
  return { id: randomUUID(), deckId, order, name: `List ${String(order).padStart(2, '0')}` }
}

export function insertList(db: Database.Database, list: DeckList) {
  db.prepare('INSERT INTO deck_lists (id, deck_id, name, list_order) VALUES (?, ?, ?, ?)')
    .run(list.id, list.deckId, list.name, list.order)
}

export function insertMember(db: Database.Database, deckId: string, member: DeckListMember) {
  db.prepare('INSERT INTO deck_list_members (entry_id, list_id, deck_id, position) VALUES (?, ?, ?, ?)')
    .run(member.entryId, member.listId, deckId, member.position)
}

export function seedDeckLists(db: Database.Database) {
  // Legacy rows have no import ordinal. Use the same order for upgrades and old JSON restores.
  const words = db.prepare(`SELECT id, deck_id AS deckId FROM entries
    ORDER BY deck_id, json_extract(body, '$.createdAt'), id`).all() as { id: string; deckId: string }[]
  let list: DeckList | undefined
  let position = 0
  for (const word of words) {
    if (list?.deckId !== word.deckId || position === listSizes.default) {
      list = nextList(word.deckId, list?.deckId === word.deckId ? list.order + 1 : 1)
      insertList(db, list)
      position = 0
    }
    insertMember(db, word.deckId, { entryId: word.id, listId: list.id, position: ++position })
  }
}

const learned = "json_extract(p.body, '$.firstCompletedAt') IS NOT NULL"

export function createListStore(db: Database.Database) {
  return {
    memberList(entryId: string) {
      return db.prepare('SELECT list_id FROM deck_list_members WHERE entry_id=?').pluck().get(entryId) as string | undefined
    },
    summaries(deckId?: string) {
      return db.prepare(`SELECT l.id, l.deck_id AS deckId, l.name, l.list_order AS "order",
        COUNT(e.id) AS count, COUNT(CASE WHEN ${learned} THEN 1 END) AS learned
        FROM deck_lists l LEFT JOIN deck_list_members m ON m.list_id=l.id
        LEFT JOIN entries e ON e.id=m.entry_id AND e.active_term IS NOT NULL
        LEFT JOIN word_progress p ON p.word_id=e.word_id
        ${deckId ? 'WHERE l.deck_id=?' : ''} GROUP BY l.id ORDER BY l.deck_id, l.list_order`)
        .all(...(deckId ? [deckId] : [])) as DeckListSummary[]
    },
    get(deckId: string, id: string) {
      return db.prepare(`SELECT ${listColumns} FROM deck_lists WHERE deck_id=? AND id=?`).get(deckId, id) as DeckList | undefined
    },
    entries(deckId: string, listId: string) {
      return (db.prepare(`SELECT e.body FROM deck_list_members m JOIN entries e ON e.id=m.entry_id
        WHERE m.list_id=? AND m.deck_id=? AND e.active_term IS NOT NULL ORDER BY m.position`)
        .all(listId, deckId) as { body: string }[]).map(({ body }) => JSON.parse(body) as Entry)
    },
    append(deck: Deck, entryIds: string[]) {
      if (!entryIds.length) return
      const size = deck.listSize ?? listSizes.default
      let list = db.prepare(`SELECT ${listColumns} FROM deck_lists WHERE deck_id=? ORDER BY list_order DESC LIMIT 1`)
        .get(deck.id) as DeckList | undefined
      let position = size
      if (list) {
        const last = db.prepare(`SELECT COALESCE(MAX(m.position), 0) AS position,
          COUNT(CASE WHEN ${learned} THEN 1 END) AS learned,
          COUNT(CASE WHEN e.active_term IS NOT NULL AND NOT (${learned}) THEN 1 END) AS remaining
          FROM deck_list_members m JOIN entries e ON e.id=m.entry_id
          LEFT JOIN word_progress p ON p.word_id=e.word_id WHERE m.list_id=?`)
          .get(list.id) as { position: number; learned: number; remaining: number }
        if (!last.learned || last.remaining) position = last.position
      }
      for (const entryId of entryIds) {
        if (!list || position >= size) {
          list = nextList(deck.id, (list?.order ?? 0) + 1)
          insertList(db, list)
          position = 0
        }
        insertMember(db, deck.id, { entryId, listId: list.id, position: ++position })
      }
    },
    export(deckId?: string) {
      const params = deckId ? [deckId] : []
      const where = deckId ? 'WHERE deck_id=?' : ''
      return {
        lists: db.prepare(`SELECT ${listColumns} FROM deck_lists ${where} ORDER BY deck_id, list_order`).all(...params) as DeckList[],
        listMembers: db.prepare(`SELECT m.entry_id AS entryId, m.list_id AS listId, m.position
          FROM deck_list_members m JOIN deck_lists l ON l.id=m.list_id
          ${deckId ? 'WHERE l.deck_id=?' : ''} ORDER BY l.deck_id, l.list_order, m.position`).all(...params) as DeckListMember[],
      }
    },
  }
}
