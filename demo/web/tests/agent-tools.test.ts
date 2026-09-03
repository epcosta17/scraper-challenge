import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TOOL_DECLARATIONS } from '../src/agent/tools.ts'

/**
 * The declarations and the implementations have to describe the same set.
 *
 * They drifted once, and silently: an edit that replaced one declaration block
 * by slicing between two others removed the two tools that happened to sit in
 * between. `runTool` still handled them, the build passed and every test
 * passed — the only symptom was the agent telling a reader it could not check
 * a job it had just queued, which is indistinguishable from the model being
 * unhelpful. Nothing in the type system connects a string in a switch to a
 * string in an array, so this is the thing that connects them.
 */
const source = readFileSync(
  fileURLToPath(new URL('../src/agent/run-tool.ts', import.meta.url)),
  'utf8',
)

const implemented = [...source.matchAll(/^\s{4}case '([a-z_]+)':/gm)].map((m) => m[1]!)
const declared = TOOL_DECLARATIONS.map((t) => t.name)

describe('the agent\'s tools', () => {
  it('declares exactly what it implements', () => {
    expect([...declared].sort()).toEqual([...implemented].sort())
  })

  it('declares no tool twice', () => {
    expect(new Set(declared).size).toBe(declared.length)
  })

  it('keeps the ones a reader depends on', () => {
    // Named rather than counted: a count passes while the wrong ten are there.
    for (const name of [
      'buscar_en_el_acervo', 'listar_expedientes', 'listar_documentos',
      'leer_expediente', 'leer_documento', 'contar',
      'buscar_en_el_portal', 'encolar_captura',
      'estado_de_la_cola', 'esperar_trabajo',
    ]) {
      expect(declared, name).toContain(name)
    }
  })

  it('gives every tool a description a model can choose by', () => {
    for (const tool of TOOL_DECLARATIONS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(80)
      expect(tool.parametersJsonSchema.type, tool.name).toBe('object')
    }
  })
})
