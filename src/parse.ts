import type { ParseResult } from './types'
import { parseFitFile } from './parser'
import { parseTcxFile } from './tcx'

/**
 * Dispatch to the right parser based on the file's extension. Both formats
 * return the same ParseResult shape so the downstream pipeline (resample,
 * align, stats, graph) is format-agnostic.
 */
export async function parseFile(file: File): Promise<ParseResult> {
  if (file.name.toLowerCase().endsWith('.tcx')) {
    return parseTcxFile(file)
  }
  return parseFitFile(file)
}

export const SUPPORTED_EXTENSIONS = ['.fit', '.tcx'] as const

export function isSupportedFile(name: string): boolean {
  const lower = name.toLowerCase()
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
