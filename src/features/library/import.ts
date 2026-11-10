import { LibraryError } from '../../../shared/domain/library'
import { MAX_IMPORT_BYTES, type ImportSource } from '../../../shared/domain/library-import'
export * from '../../../shared/domain/library-import'

export async function readImportFile(file: File): Promise<{ format: ImportSource['format']; text: string }> {
  if (file.size > MAX_IMPORT_BYTES) throw new LibraryError('The file exceeds the 5 MiB limit.')
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (extension !== 'txt' && extension !== 'csv') throw new LibraryError('Choose a .txt or .csv file.')
  const bytes = await file.arrayBuffer()
  try {
    return { format: extension, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    throw new LibraryError('Save the file as UTF-8 and try again.')
  }
}
