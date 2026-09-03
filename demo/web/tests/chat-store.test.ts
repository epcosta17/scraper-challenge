import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openChatStore, titleFrom, type ChatStore } from '../src/data/chat-store.ts'

let dir: string
let store: ChatStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-test-'))
  store = openChatStore(join(dir, 'nested', 'chat.db'))
  return () => rmSync(dir, { recursive: true, force: true })
})

describe('titleFrom', () => {
  it('collapses whitespace and cuts long questions', () => {
    expect(titleFrom('  muéstrame\n  3   documentos ')).toBe('muéstrame 3 documentos')
    expect(titleFrom('x'.repeat(80))).toHaveLength(60)
    expect(titleFrom('   ')).toBe('Sin título')
  })
})

describe('the chat store', () => {
  it('keeps the reasoning trace with the answer', () => {
    // The trace is the reason any of this is stored: an answer without the
    // steps behind it is exactly what the reader could already see.
    const c = store.create('muestrame 3 documentos')
    store.append(c.id, 'user', 'muestrame 3 documentos')
    store.append(c.id, 'model', 'Aquí tienes 3.', [
      { type: 'thought', text: 'Eligiendo herramienta' },
      { type: 'tool', name: 'listar_documentos', args: { orden: 'aleatorio' } },
    ])

    const read = store.read(c.id)!
    expect(read.turns).toHaveLength(2)
    expect(read.turns[0]!.trace).toEqual([])
    expect(read.turns[1]!.trace).toHaveLength(2)
    expect((read.turns[1]!.trace[1] as { name: string }).name).toBe('listar_documentos')
  })

  it('orders the list by real activity, not by when it was started', () => {
    const first = store.create('la primera')
    const second = store.create('la segunda')
    // The older conversation gets a new turn, so it belongs at the top.
    store.append(first.id, 'user', 'algo más')

    const listed = store.list(10)
    expect(listed.map((c) => c.id)).toEqual([first.id, second.id])
    expect(listed[0]!.turns).toBe(1)
  })

  it('deletes a conversation with its turns', () => {
    const c = store.create('para borrar')
    store.append(c.id, 'user', 'hola')
    expect(store.remove(c.id)).toBe(true)
    expect(store.read(c.id)).toBeNull()
    // The cascade has to have taken the turns too, or the next conversation to
    // reuse the id would inherit somebody else's thread.
    expect(store.list(10)).toHaveLength(0)
  })

  it('refuses to write into a conversation that is not there', () => {
    expect(store.append(999, 'user', 'hola')).toBeNull()
    expect(store.rename(999, 'x')).toBe(false)
    expect(store.remove(999)).toBe(false)
    expect(store.read(999)).toBeNull()
  })
})
