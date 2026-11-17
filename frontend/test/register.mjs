/**
 * Node 测试引导：注册 ESM loader（esbuild 转译 TS + 「@/」别名）。
 * 用法：node --import ./test/register.mjs --test ...
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
register(pathToFileURL(pathResolve(here, 'esm-loader.mjs')).href)
