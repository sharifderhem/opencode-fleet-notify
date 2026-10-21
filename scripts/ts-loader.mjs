import ts from 'typescript'
import { readFile, access } from 'node:fs/promises'
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    try { await access(url); return { url: url.href, shortCircuit: true } } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url.endsWith('.ts') && !url.includes('/node_modules/')) {
    const source = await readFile(new URL(url), 'utf8')
    return { format: 'module', source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true }
  }
  return next(url, context)
}
