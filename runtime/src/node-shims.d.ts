declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function readFile(path: string, options?: string | { encoding?: string }): Promise<string | Uint8Array>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function writeFile(path: string, data: string, options?: string | { encoding?: string }): Promise<void>
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...paths: string[]): string
}

declare module 'node:crypto' {
  export function randomUUID(): string
}

declare const process: {
  env: Record<string, string | undefined>
  cwd(): string
}
