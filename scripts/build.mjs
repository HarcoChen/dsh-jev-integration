import { copyFile, mkdir, rm } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const localTsc = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
const siblingTsc = join(root, '..', 'dsh-ide', 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
const tsc = (await exists(localTsc)) ? localTsc : siblingTsc
if (!(await exists(tsc))) {
  throw new Error('TypeScript compiler not found. Run pnpm install or provide a local TypeScript installation.')
}

await rm(dist, { recursive: true, force: true })
await new Promise((resolvePromise, reject) => {
  const child = spawn(tsc, ['-p', join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`tsc exited with ${code}`)))
})

await mkdir(join(dist, 'protocol', 'schema'), { recursive: true })
await mkdir(join(dist, 'runtime'), { recursive: true })
await copyFile(join(root, 'protocol', 'schema', 'jev-integration.schema.json'), join(dist, 'protocol', 'schema', 'jev-integration.schema.json'))
await copyFile(join(root, 'runtime', 'cordis.patch.yml'), join(dist, 'runtime', 'cordis.patch.yml'))
console.log(`Built dsh-jev-integration ${join(root, 'dist')}`)
