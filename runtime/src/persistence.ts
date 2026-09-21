import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IntegrationConfig, IntegrationConfigPatch, StatisticsSnapshot } from '../../protocol/src/index.js'

export interface PersistedConfigFile {
  version: 1
  global: IntegrationConfigPatch
  workspaces: Record<string, IntegrationConfigPatch>
}

export interface PersistedStatsFile {
  version: 1
  scopes: Record<string, StatisticsSnapshot>
}

export interface PersistencePaths {
  rootDir: string
  configFile: string
  statsFile: string
}

function homeDshDir(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function defaultPersistencePaths(override?: string): PersistencePaths {
  const rootDir = override ?? process.env.DSH_JEV_INTEGRATION_HOME ?? join(homeDshDir(), 'jev-integration')
  return {
    rootDir,
    configFile: join(rootDir, 'config.json'),
    statsFile: join(rootDir, 'stats.json'),
  }
}

function emptyConfig(): PersistedConfigFile {
  return { version: 1, global: {}, workspaces: {} }
}

function emptyStats(): PersistedStatsFile {
  return { version: 1, scopes: {} }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8')
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    const value: unknown = JSON.parse(text)
    return value as T
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

export class IntegrationPersistence {
  public readonly paths: PersistencePaths

  public constructor(rootDir?: string) {
    this.paths = defaultPersistencePaths(rootDir)
  }

  public async loadConfig(): Promise<PersistedConfigFile> {
    const value = await readJson(this.paths.configFile, emptyConfig())
    if (!value || value.version !== 1 || typeof value.global !== 'object' || typeof value.workspaces !== 'object') {
      return emptyConfig()
    }
    return value
  }

  public async saveConfig(value: PersistedConfigFile): Promise<void> {
    await writeJsonAtomic(this.paths.configFile, value)
  }

  public async loadStats(): Promise<PersistedStatsFile> {
    const value = await readJson(this.paths.statsFile, emptyStats())
    if (!value || value.version !== 1 || typeof value.scopes !== 'object') return emptyStats()
    return value
  }

  public async saveStats(value: PersistedStatsFile): Promise<void> {
    await writeJsonAtomic(this.paths.statsFile, value)
  }
}
