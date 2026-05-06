import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist')
const outputDir = path.join(projectRoot, '.hono-image-cache')
const allowedRoutes = new Set([
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/chat/completions',
])
const taskRetentionMs = 60 * 60 * 1000
const tasks = new Map()

function nowIso() {
  return new Date().toISOString()
}

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(statusCode, {
    'Content-Length': String(body.length),
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(body)
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.ico') return 'image/x-icon'
  return 'application/octet-stream'
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function parseJsonBody(body) {
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('请求体不是有效 JSON。')
  }
}

function readBaseUrl(req) {
  const rawBaseUrl = String(req.headers['x-image-base-url'] || '').trim().replace(/\/+$/, '')
  const baseUrl = rawBaseUrl || 'https://api.honoacc.com'
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Base URL 只支持 http 或 https。')
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
}

function validateRoute(route) {
  if (!allowedRoutes.has(route)) {
    throw new Error(`不支持的图像接口路径：${route || '空'}`)
  }
  return route
}

function cleanupTasks() {
  const expiredBefore = Date.now() - taskRetentionMs
  for (const [taskId, task] of tasks) {
    if (task.createdAtMs < expiredBefore) tasks.delete(taskId)
  }
}

function serializeTask(task) {
  return {
    assets: task.assets,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    elapsed: (task.completedAtMs || Date.now()) - task.createdAtMs,
    error: task.error,
    id: task.id,
    result: task.result,
    route: task.route,
    startedAt: task.startedAt,
    status: task.status,
    statusCode: task.statusCode,
    target: task.target,
    updatedAt: task.updatedAt,
    upstreamTaskId: task.upstreamTaskId,
    upstreamTaskStatusUrl: task.upstreamTaskStatusUrl,
  }
}

function readUpstreamTaskId(payload) {
  const direct = payload.task_id || payload.taskId || payload.id || payload.asyncTaskId
  if (typeof direct === 'string' && direct) return direct

  const data = payload.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data.task_id || data.taskId || data.id || data.asyncTaskId
    if (typeof nested === 'string' && nested) return nested
  }

  return undefined
}

function getErrorDetails(error) {
  if (!error || typeof error !== 'object') return {}
  return {
    cause: error.cause instanceof Error ? error.cause.message : error.cause,
    code: error.code,
    errno: error.errno,
    name: error.name,
    syscall: error.syscall,
  }
}

function buildTaskErrorMessage(error, task) {
  const elapsed = Date.now() - task.createdAtMs
  const message = error instanceof Error ? error.message : 'Image task failed.'
  const details = getErrorDetails(error)
  const code = typeof details.code === 'string' ? details.code : ''
  const syscall = typeof details.syscall === 'string' ? details.syscall : ''
  const errno = typeof details.errno === 'string' || typeof details.errno === 'number'
    ? String(details.errno)
    : ''

  return [
    message,
    code ? `code: ${code}` : '',
    syscall ? `syscall: ${syscall}` : '',
    errno ? `errno: ${errno}` : '',
    `target: ${task.target}`,
    `elapsed: ${elapsed}ms`,
    elapsed >= 55_000 && elapsed <= 70_000
      ? '上游连接在约 60 秒被断开；独立任务层已记录失败，但上游没有返回可继续查询的 task_id。'
      : '',
  ].filter(Boolean).join(' ')
}

function readUpstreamError(payload, status) {
  const error = payload.error
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message || `上游接口请求失败 (${status})。`)
  }
  return `上游接口请求失败 (${status})。`
}

async function requestUpstream({ authorization, body, contentType, method, url }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error('Image API request timed out after 600 seconds.'))
  }, 600_000)

  try {
    const response = await fetch(url, {
      body,
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'Content-Type': contentType,
      },
      method,
      signal: controller.signal,
    })
    const text = await response.text()
    let payload = {}
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { raw: text }
      }
    }
    return {
      headers: Object.fromEntries(response.headers.entries()),
      payload,
      statusCode: response.status,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeOutputFormat(format = 'png') {
  const normalized = String(format).trim().toLowerCase()
  if (normalized === 'jpg') return 'jpeg'
  return normalized || 'png'
}

function looksLikeBase64(value) {
  return typeof value === 'string' && value.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(value)
}

async function persistDataUrl(taskId, index, dataUrl) {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) return dataUrl

  const extension = match[1] === 'jpeg' ? 'jpg' : match[1]
  const fileName = `${taskId}-${index + 1}.${extension}`
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(outputDir, fileName), Buffer.from(match[2], 'base64'))
  return `/api/image-assets/${fileName}`
}

async function normalizeAssets(payload, taskId, requestPayload) {
  if (payload.choices?.length) {
    return payload.choices.flatMap((choice, index) => {
      const url = choice.message?.images?.[0]?.image_url?.url
      if (!url) return []
      return [{
        createdAt: nowIso(),
        id: `asset_${randomUUID()}`,
        index,
        prompt: requestPayload.prompt || '',
        taskId,
        title: `Generated ${index + 1}`,
        url,
      }]
    })
  }

  const items = Array.isArray(payload.data) ? payload.data : []
  const assets = []
  for (const [index, item] of items.entries()) {
    const format = normalizeOutputFormat(item.output_format || requestPayload.output_format)
    const dataUrl = item.data_url || item.dataUrl
    let url
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
      url = await persistDataUrl(taskId, index, dataUrl)
    }

    const base64 = item.b64_json || item.b64Json || item.base64 || item.image_base64
    if (!url && base64) {
      const cleanBase64 = String(base64).startsWith('data:image/')
        ? String(base64).split(',')[1]
        : String(base64)
      url = await persistDataUrl(taskId, index, `data:image/${format};base64,${cleanBase64}`)
    }

    const image = item.image
    if (!url && typeof image === 'string' && image.startsWith('data:image/')) {
      url = await persistDataUrl(taskId, index, image)
    }
    if (!url && looksLikeBase64(image)) {
      url = await persistDataUrl(taskId, index, `data:image/${format};base64,${image}`)
    }

    if (!url) url = item.url || item.image_url || item.imageUrl
    if (!url) continue

    assets.push({
      createdAt: nowIso(),
      id: `asset_${randomUUID()}`,
      index,
      prompt: item.revised_prompt || requestPayload.prompt || '',
      taskId,
      title: `Generated ${index + 1}`,
      url,
    })
  }
  return assets
}

async function runTask({ authorization, payload, task }) {
  task.status = 'running'
  task.startedAt = nowIso()
  task.updatedAt = task.startedAt

  try {
    const upstreamResponse = await requestUpstream({
      authorization,
      body: Buffer.from(JSON.stringify(payload)),
      contentType: 'application/json',
      method: 'POST',
      url: task.target,
    })

    task.statusCode = upstreamResponse.statusCode
    task.updatedAt = nowIso()

    if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
      task.status = 'failed'
      task.error = {
        code: 'upstream_image_api_error',
        message: readUpstreamError(upstreamResponse.payload, upstreamResponse.statusCode),
        status: upstreamResponse.statusCode,
      }
      return
    }

    task.upstreamTaskId = readUpstreamTaskId(upstreamResponse.payload)
    task.result = upstreamResponse.payload
    task.assets = await normalizeAssets(upstreamResponse.payload, task.id, payload)
    task.status = 'succeeded'
  } catch (error) {
    task.status = 'failed'
    task.error = {
      code: 'image_task_worker_error',
      details: getErrorDetails(error),
      message: buildTaskErrorMessage(error, task),
    }
  } finally {
    task.completedAt = nowIso()
    task.completedAtMs = Date.now()
    task.updatedAt = task.completedAt
    console.info(`[image-task-server] ${task.status} ${task.id} ${task.target} elapsed=${task.completedAtMs - task.createdAtMs}ms`)
  }
}

async function handleCreateTask(req, res) {
  const startedAtMs = Date.now()
  let baseUrl = ''
  try {
    cleanupTasks()
    baseUrl = readBaseUrl(req)
    const input = parseJsonBody(await readBody(req))
    const route = validateRoute(String(input.route || ''))
    const payload = input.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('缺少有效的 payload。')
    }

    const taskId = `img_${randomUUID()}`
    const task = {
      assets: [],
      createdAt: new Date(startedAtMs).toISOString(),
      createdAtMs: startedAtMs,
      id: taskId,
      route,
      status: 'queued',
      target: `${baseUrl}${route}`,
      updatedAt: new Date(startedAtMs).toISOString(),
    }
    tasks.set(taskId, task)

    setImmediate(() => {
      void runTask({
        authorization: String(req.headers.authorization || ''),
        payload,
        task,
      })
    })

    writeJson(res, 202, serializeTask(task))
    console.info(`[image-task-server] accepted ${taskId} ${task.target}`)
  } catch (error) {
    writeJson(res, 400, {
      error: {
        code: 'image_task_create_error',
        message: [
          '创建图像任务失败。',
          baseUrl ? `target: ${baseUrl}` : '',
          error instanceof Error ? error.message : 'Invalid image task request.',
          `elapsed: ${Date.now() - startedAtMs}ms`,
        ].filter(Boolean).join(' '),
      },
    })
  }
}

async function handleAsset(req, res) {
  const fileName = decodeURIComponent(req.url.replace(/^\/api\/image-assets\//, '').split('?')[0])
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
    writeJson(res, 400, { error: { code: 'invalid_asset_name', message: '无效的图片文件名。' } })
    return
  }
  const filePath = path.join(outputDir, fileName)
  const body = await readFile(filePath).catch(() => undefined)
  if (!body) {
    writeJson(res, 404, { error: { code: 'asset_not_found', message: '图片资源不存在。' } })
    return
  }
  const ext = path.extname(fileName).slice(1).toLowerCase()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`
  res.writeHead(200, { 'Content-Length': String(body.length), 'Content-Type': mime })
  res.end(body)
}

async function handleStatic(req, res) {
  const rawPath = decodeURIComponent((req.url || '/').split('?')[0])
  const safePath = rawPath === '/' ? '/index.html' : rawPath
  const candidate = path.normalize(path.join(distDir, safePath))
  const distRoot = path.normalize(distDir + path.sep)
  const filePath = candidate.startsWith(distRoot) ? candidate : path.join(distDir, 'index.html')
  const resolvedPath = await stat(filePath).then((item) => item.isFile() ? filePath : path.join(distDir, 'index.html')).catch(() => path.join(distDir, 'index.html'))
  const body = await readFile(resolvedPath).catch(() => undefined)
  if (!body) {
    writeJson(res, 404, { error: { code: 'static_not_found', message: '前端构建产物不存在，请先运行 npm run build。' } })
    return
  }
  res.writeHead(200, {
    'Content-Length': String(body.length),
    'Content-Type': contentTypeFor(resolvedPath),
  })
  res.end(body)
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === 'POST' && req.url === '/api/image-tasks') {
        await handleCreateTask(req, res)
        return
      }

      if (req.method === 'GET' && req.url?.startsWith('/api/image-tasks/')) {
        const taskId = decodeURIComponent(req.url.replace(/^\/api\/image-tasks\//, '').split('?')[0])
        const task = tasks.get(taskId)
        if (!task) {
          writeJson(res, 404, {
            error: { code: 'image_task_not_found', message: `找不到任务 ${taskId}。` },
          })
          return
        }
        writeJson(res, 200, serializeTask(task))
        return
      }

      if (req.method === 'GET' && req.url?.startsWith('/api/image-assets/')) {
        await handleAsset(req, res)
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await handleStatic(req, res)
        return
      }

      writeJson(res, 404, { error: { code: 'not_found', message: 'Not found.' } })
    } catch (error) {
      writeJson(res, 500, {
        error: {
          code: 'image_task_server_error',
          message: error instanceof Error ? error.message : 'Image task server error.',
        },
      })
    }
  })()
})

const port = Number(process.env.PORT || process.env.HONO_IMAGE_API_PORT || 5190)
const host = process.env.HOST || '127.0.0.1'
server.listen(port, host, () => {
  console.info(`[image-task-server] listening http://${host}:${port}`)
})
