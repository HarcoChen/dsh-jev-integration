import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cache = await mkdtemp(join(tmpdir(), 'dsh-jev-npm-cache-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
  await new Promise((resolve, reject) => {
    const child = spawn(npm, ['pack', '--dry-run', '--cache', cache], {
      cwd: process.cwd(),
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm pack exited with ${code}`)))
  })
} finally {
  await rm(cache, { recursive: true, force: true })
}
