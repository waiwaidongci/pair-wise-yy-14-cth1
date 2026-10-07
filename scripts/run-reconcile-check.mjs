// 打包并运行对账规则断言（使用 pnpm 安装树中的 esbuild，无需新增依赖）。
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, readdirSync, existsSync } from 'node:fs'

const storeDir = 'node_modules/.pnpm'
const esbuildPkg = readdirSync(storeDir).find((name) => /^esbuild@/.test(name))
if (!esbuildPkg) throw new Error('未找到 esbuild，请先执行 pnpm install')
const mainPath = join(storeDir, esbuildPkg, 'node_modules/esbuild/lib/main.js')
if (!existsSync(mainPath)) throw new Error(`esbuild 入口不存在：${mainPath}`)
const { build } = await import(pathToFileURL(join(process.cwd(), mainPath)).href)

const outfile = join(tmpdir(), 'reconcile-check.mjs')
await build({
  entryPoints: ['scripts/reconcile-check.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'warning',
})
try {
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(outfile, { force: true })
}
