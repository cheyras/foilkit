// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// A static file server for the browser-side pages — the pattern room, and the
// stage's stress demo. node: builtins only — the pages it serves are plain ESM
// + an import map, so there is no bundler in this loop and nothing between the
// source and the pixels.
//
//   node tools/parity/serve.mjs [--port 5199] [--page <html>] [--mount /alias=<dir>]…
//
// Routes:
//   /                          -> --page, default tools/parity/host/index.html
//   /vendor/three.module.js    -> node_modules/three/build/three.module.js
//   /packages/… /data/…        -> the repository, as-is
//   /<alias>/…                 -> whatever --mount pointed at (the moving
//                                 receipt mounts a build of the ORIGIN repo's
//                                 modules here, so the same page can render
//                                 both sides)

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const PORT = Number(arg('port', '5199'))
// Which page answers "/". Everything else it needs — its own module, the
// packages, the canon files — resolves through the generic repository route
// below, so a second page costs a flag rather than a second server.
const PAGE = arg('page', 'tools/parity/host/index.html')

/** @type {Map<string, string>} alias -> absolute dir */
const mounts = new Map()
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--mount') continue
  const spec = argv[i + 1] ?? ''
  const eq = spec.indexOf('=')
  if (eq < 0) throw new Error(`--mount wants /alias=<dir>, got ${spec}`)
  // Git Bash rewrites a leading-slash argument into a Windows path, so the
  // alias is normalised rather than trusted: backslashes to slashes, and a
  // leading slash added if the shell ate it.
  const alias = spec.slice(0, eq).split('\\').join('/').replace(/\/+$/, '')
  const leaf = alias.slice(alias.lastIndexOf('/') + 1)
  mounts.set(`/${leaf}`, resolve(spec.slice(eq + 1)))
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function resolvePath(urlPath) {
  if (urlPath === '/' || urlPath === '') return join(ROOT, PAGE)
  if (urlPath === '/main.js') return join(ROOT, PAGE.replace(/[^/\\]+$/, 'main.js'))
  // The whole three build directory: three.module.js re-exports three.core.js.
  if (urlPath.startsWith('/vendor/')) return join(ROOT, 'node_modules/three/build', urlPath.slice('/vendor/'.length))
  for (const [alias, dir] of mounts) {
    if (urlPath === alias || urlPath.startsWith(`${alias}/`)) {
      const rel = normalize(urlPath.slice(alias.length)).replace(/^[\\/]+/, '')
      const p = join(dir, rel)
      return p.startsWith(dir) ? p : null
    }
  }
  const rel = normalize(urlPath).replace(/^[\\/]+/, '')
  const p = join(ROOT, rel)
  return p.startsWith(ROOT) ? p : null
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  const p = resolvePath(urlPath)
  if (!p || !existsSync(p) || !statSync(p).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`not found: ${urlPath}`)
    return
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  createReadStream(p).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${PAGE}: http://127.0.0.1:${PORT}/  root=${ROOT}`)
  for (const [a, d] of mounts) console.log(`  mount ${a} -> ${d}`)
})
