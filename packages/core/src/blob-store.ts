import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Swappable so PDFs can move to Cloud Storage without touching callers. */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>
  get(key: string): Promise<Buffer>
  exists(key: string): Promise<boolean>
}

export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const full = resolve(join(this.root, key))
    if (!full.startsWith(resolve(this.root))) throw new Error(`Key escapes blob root: ${key}`)
    return full
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, data)
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.path(key))
      return true
    } catch {
      return false
    }
  }
}
