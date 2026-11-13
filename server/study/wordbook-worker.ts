import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'
import type { ReviewSchedulerConfig } from '../../shared/domain/review.ts'
import { createEcdict, type Ecdict } from '../dictionary/ecdict.ts'
import { createStudyStore, StudyError, type StudyStore } from './store.ts'
import { installBuiltinBook } from './wordbooks.ts'

export interface InstallRequest {
  path: string
  dataDir?: string
  ownerId: string
  requestId: string
  payload: string
  args: Parameters<typeof installBuiltinBook> extends [StudyStore, ReviewSchedulerConfig, Ecdict | undefined, ...infer Args] ? Args : never
  config: Parameters<typeof installBuiltinBook>[1]
}

export type InstallResult =
  | { result: ReturnType<typeof installBuiltinBook> }
  | { message: string; status: StudyError['status'] }

const { path, dataDir, ownerId, requestId, payload, args, config } = workerData as InstallRequest
const db = new Database(path, { fileMustExist: true })
const dictionary = createEcdict(dataDir)
try {
  db.pragma('foreign_keys = ON')
  const store = createStudyStore(db, ownerId)
  const result = store.request(requestId, payload, () => installBuiltinBook(store, config, dictionary, ...args))
  parentPort!.postMessage({ result } satisfies InstallResult)
} catch (error) {
  if (!(error instanceof StudyError)) throw error
  parentPort!.postMessage({ message: error.message, status: error.status } satisfies InstallResult)
} finally {
  dictionary.close()
  db.close()
}
