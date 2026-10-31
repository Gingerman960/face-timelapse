import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect, Plugin, ViteDevServer } from 'vite'

type ImageRoutes = typeof import('../src/ipc/mock/imageRoutes')

const ROUTES_MODULE = '/src/ipc/mock/imageRoutes.ts'

/**
 * Serves deterministic SVG stand-ins for the mock backend's image routes:
 * `GET /__mock/img/thumb/{id}`, `/aligned/{id}`, `/reference`, `/reference/frame`
 * (any `?w=&v=`). Built from `src/ipc/mock/fixtures.ts`, so the images match
 * the fake backend's geometry. Never serves real photos.
 *
 * The renderer is loaded through Vite's own module runner on first request,
 * so the config file imports nothing from `src/` (keeps the config loadable
 * by every `configLoader`, and keeps the mock out of config start-up).
 */
export function mockImages(): Plugin {
  let routes: Promise<ImageRoutes> | null = null
  let loader: (() => Promise<ImageRoutes>) | null = null

  const middleware: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next) => {
    if (!(req.url ?? '').startsWith('/__mock/img/') || !loader) {
      next()
      return
    }
    routes ??= loader()
    routes
      .then(({ handleMockImageRequest }) => {
        const response = handleMockImageRequest(req.method ?? 'GET', req.url ?? '/')
        if (!response) {
          next()
          return
        }
        res.statusCode = response.status
        for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value)
        res.end(response.body)
      })
      .catch((error: unknown) => {
        routes = null
        console.error('[mock-images]', error)
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('Mock image failed')
      })
  }

  return {
    name: 'ft-mock-images',
    configureServer(server: ViteDevServer) {
      loader = () => server.ssrLoadModule(ROUTES_MODULE) as Promise<ImageRoutes>
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      // `vite preview` has no module runner: start a minimal one on demand.
      loader = async () => {
        const { createServer } = await import('vite')
        const runner = await createServer({ configFile: false, root: server.config.root, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
        return (await runner.ssrLoadModule(ROUTES_MODULE)) as ImageRoutes
      }
      server.middlewares.use(middleware)
    },
  }
}
