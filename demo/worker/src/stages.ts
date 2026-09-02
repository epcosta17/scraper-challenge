import type { DeepStepEvent } from '@pje/scraper'

/**
 * What a step of the deep engine is called on a screen.
 *
 * This exists because a counter is not enough to say a job is alive. Capturing
 * one case spends most of its time before the first document is known — the
 * summary PDF, the search bridge that resolves the detail key, the case file
 * itself — and through all of it the count is 0 with no total, which reads
 * exactly like a run that has hung. The engine already names each of those
 * steps for `--verbose`; this is the same names, kept for the queue row.
 *
 * The retry steps say so plainly rather than hiding a slow patch: a job that
 * is on its third go at the portal is still working, and a person watching
 * deserves to know that is what the wait is.
 *
 * Returns null for the steps that a number already covers. Once documents are
 * being downloaded, `3 / 9` says more than any phrase would, and overwriting
 * the stage on every document would only make the line flicker.
 */
export function stageOf(e: DeepStepEvent): string | null {
  switch (e.kind) {
    case 'summary_pdf': return 'fetching the summary PDF'
    case 'summary_pdf_retry': return `retrying the summary PDF (${e.attempt} of ${e.of}, HTTP ${e.status})`
    case 'summary_pdf_ok': return `got ${e.number}`
    case 'detail_key': return e.source === 'search'
      ? 'resolving the detail key through the search bridge'
      : 'resolving the detail key'
    case 'detail_key_retry': return `retrying the detail key (${e.attempt} of ${e.of})`
    case 'case_file': return 'reading the case file'
    case 'case_file_ok': return `the case file lists ${e.documentCount} documents`
    case 'documents': return null
  }
}
