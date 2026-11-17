/**
 * Node ESM loader（由 register.mjs 注册）：esbuild 即时转译 TS，「@/」别名解析到 src/。
 * 仅供 node --test 使用，不参与前端构建。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'
import { existsSync } from 'node:fs'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = pathResolve(here, '..', 'src')

const aliasPlugin = {
  name: 'at-alias',
  setup(bundler) {
    bundler.onResolve({ filter: /^@\// }, (args) => {
      const base = args.path.slice(2)
      const candidates = [
        pathResolve(srcRoot, base),
        pathResolve(srcRoot, `${base}.ts`),
        pathResolve(srcRoot, base, 'index.ts'),
      ]
      const found = candidates.find((candidate) => existsSync(candidate))
      if (!found) return { errors: [{ text: `无法解析别名导入 ${args.path}` }] }
      return { path: found }
    })
  },
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = specifier.slice(2)
    const candidates = [
      pathResolve(srcRoot, base),
      pathResolve(srcRoot, `${base}.ts`),
      pathResolve(srcRoot, base, 'index.ts'),
    ]
    const found = candidates.find((candidate) => existsSync(candidate))
    if (found) return nextResolve(pathToFileURL(found).href, context)
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const result = await build({
      entryPoints: [fileURLToPath(url)],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      plugins: [aliasPlugin],
    })
    return { format: 'module', source: result.outputFiles[0].text, shortCircuit: true }
  }
  return nextLoad(url, context)
}
