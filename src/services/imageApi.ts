import type { ApiSettings, GenerationParams, ImageAsset, ImageModel, ImageTask, ImageTaskDebug } from '../types/image'
import { createClientId } from '../utils/id'

export async function listModels(): Promise<ImageModel[]> {
  return [
    {
      id: 'gpt-image-2',
      label: 'GPT Image 2',
      description: 'OpenAI image generation, editing, and iterative creation model.',
      supportsEdit: true,
      supportsContinuation: true,
    },
    {
      id: 'gpt-image-2-fast',
      label: 'GPT Image 2 Fast',
      description: 'Placeholder profile for faster preview workflows.',
      supportsEdit: true,
      supportsContinuation: true,
    },
  ]
}

export async function createImageTask(params: GenerationParams, settings: ApiSettings): Promise<ImageTask> {
  return createImageTaskWithProgress(params, settings)
}

export async function createImageTaskWithProgress(
  params: GenerationParams,
  settings: ApiSettings,
  onProgress?: (event: LocalImageTaskProgress) => void,
): Promise<ImageTask> {
  const submittedTask = await submitImageTask(params, settings)
  onProgress?.(submittedTask.progress)
  return pollImageTaskWithProgress(submittedTask, settings, onProgress)
}

export function prepareImageTaskRequest(params: GenerationParams, settings: ApiSettings) {
  const route = resolveRoute(params)
  const payload = buildOpenAiImagePayload(params)
  return {
    debug: {
      endpoint: `${normalizeBaseUrl(settings.baseUrl)}${route}`,
      localEndpoint: '/api/image-tasks',
      payload,
    } satisfies ImageTaskDebug,
    payload,
    route,
  }
}

export async function submitImageTask(params: GenerationParams, settings: ApiSettings) {
  const request = prepareImageTaskRequest(params, settings)
  const task = await submitLocalImageTask({
    payload: request.payload,
    route: request.route,
    settings,
  })
  return {
    debug: {
      ...request.debug,
      endpoint: task.target || request.debug.endpoint,
      taskId: task.id,
      taskStatus: task.status,
    },
    params,
    progress: task,
    submittedAt: new Date().toISOString(),
  }
}

export async function pollImageTaskWithProgress(
  submittedTask: SubmittedImageTask,
  settings: ApiSettings,
  onProgress?: (event: LocalImageTaskProgress) => void,
): Promise<ImageTask> {
  const now = submittedTask.submittedAt
  const completedTask = await pollLocalImageTask(submittedTask.progress.id, settings, onProgress)
  if (completedTask.status === 'failed') {
    throw new Error(completedTask.error?.message || '本地异步图像任务失败。')
  }
  if (completedTask.status !== 'succeeded') {
    throw new Error(`本地异步图像任务未完成：${completedTask.status}`)
  }

  const responsePayload = completedTask.result ?? {}
  const assets = normalizeTaskAssets(completedTask, submittedTask.params, now) || normalizeImageResponse(responsePayload, submittedTask.params, completedTask.id, now)
  if (!assets.length) {
    throw new Error(`接口没有返回可用图片。${describeImagePayload(responsePayload)}`)
  }

  return {
    id: completedTask.id,
    mode: submittedTask.params.mode,
    model: submittedTask.params.model,
    prompt: submittedTask.params.prompt,
    status: 'succeeded',
    createdAt: now,
    completedAt: completedTask.completedAt || new Date().toISOString(),
    assets,
  }
}

export function buildImageTaskDebug(params: GenerationParams, settings: ApiSettings): ImageTaskDebug {
  const route = resolveRoute(params)
  return {
    endpoint: `${normalizeBaseUrl(settings.baseUrl)}${route}`,
    localEndpoint: '/api/image-tasks',
    payload: buildOpenAiImagePayload(params),
  }
}

async function submitLocalImageTask({
  payload,
  route,
  settings,
}: {
  payload: Record<string, unknown>
  route: string
  settings: ApiSettings
}): Promise<LocalImageTaskProgress> {
  const response = await fetch('/api/image-tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      'Content-Type': 'application/json',
      'X-Image-Base-URL': normalizeBaseUrl(settings.baseUrl),
    },
    body: JSON.stringify({
      payload,
      route,
    }),
  })

  const body = await parseJson<LocalImageTaskProgress>(response)
  if (!response.ok) {
    throw new Error(readApiError(body, response.status))
  }

  return body
}

async function pollLocalImageTask(
  taskId: string,
  settings: ApiSettings,
  onProgress?: (event: LocalImageTaskProgress) => void,
): Promise<LocalImageTaskProgress> {
  const deadline = Date.now() + 10 * 60 * 1000
  let interval = 1500

  while (Date.now() < deadline) {
    await wait(interval)
    const response = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        'X-Image-Base-URL': normalizeBaseUrl(settings.baseUrl),
      },
    })
    const body = await parseJson<LocalImageTaskProgress>(response)
    if (!response.ok) {
      throw new Error(readApiError(body, response.status))
    }

    onProgress?.(body)
    if (body.status === 'succeeded' || body.status === 'failed') return body
    interval = Math.min(5000, interval + 500)
  }

  throw new Error(`本地异步任务轮询超时：${taskId}`)
}

type ImageResponsePayload = {
  choices?: Array<{
    message?: {
      images?: Array<{
        image_url?: {
          url?: string
        }
      }>
    }
  }>
  data?: Array<{
    b64_json?: string
    b64Json?: string
    base64?: string
    image?: string
    image_base64?: string
    data_url?: string
    dataUrl?: string
    url?: string
    image_url?: string
    imageUrl?: string
    output_format?: string
    revised_prompt?: string
  }>
  error?: {
    message?: string
    code?: string
  }
}

type LocalImageTaskProgress = {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  route?: string
  target?: string
  createdAt?: string
  updatedAt?: string
  startedAt?: string
  completedAt?: string
  elapsed?: number
  statusCode?: number
  upstreamTaskId?: string
  upstreamTaskStatusUrl?: string
  result?: ImageResponsePayload
  assets?: Array<{
    createdAt?: string
    id?: string
    prompt?: string
    taskId?: string
    title?: string
    url: string
  }>
  error?: {
    message?: string
    code?: string
    status?: number
    details?: Record<string, unknown>
  }
}

export type SubmittedImageTask = {
  debug: ImageTaskDebug
  params: GenerationParams
  progress: LocalImageTaskProgress
  submittedAt: string
}

function buildOpenAiImagePayload(params: GenerationParams) {
  if (params.apiMode === 'chat-image') {
    const model = params.model.endsWith(':image') ? params.model : `${params.model}:image`
    return {
      messages: [
        {
          content: [
            {
              text: params.prompt,
              type: 'text',
            },
            ...params.referenceImages.map((asset) => ({
              image_url: {
                url: asset.url,
              },
              type: 'image_url',
            })),
          ],
          role: 'user',
        },
      ],
      model,
      stream: false,
    }
  }

  const basePayload: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    n: params.count,
  }
  if (params.size !== 'auto') {
    basePayload.size = params.size
  }
  if (params.quality !== 'auto') {
    basePayload.quality = params.quality
  }
  if (params.outputFormat && params.outputFormat !== 'png') {
    basePayload.output_format = params.outputFormat
  }

  if (params.mode === 'generate') {
    return basePayload
  }

  return {
    ...basePayload,
    images: params.referenceImages.map((asset) => ({
      image_url: asset.url,
    })),
  }
}

function resolveRoute(params: GenerationParams) {
  if (params.apiMode === 'chat-image') return '/v1/chat/completions'
  return params.mode === 'generate' ? '/v1/images/generations' : '/v1/images/edits'
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '') || 'https://api.honoacc.com'
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function normalizeTaskAssets(
  task: LocalImageTaskProgress,
  params: GenerationParams,
  createdAt: string,
): ImageAsset[] | undefined {
  if (!task.assets?.length) return undefined
  return task.assets.map((asset, index) => ({
    createdAt: asset.createdAt || createdAt,
    height: params.size.includes('1536') ? 1536 : 900,
    id: asset.id || createClientId('asset'),
    mode: params.mode,
    prompt: asset.prompt || params.prompt,
    taskId: asset.taskId || task.id,
    title: asset.title || `${params.mode === 'generate' ? 'Generated' : params.mode === 'edit' ? 'Edited' : 'Continued'} ${index + 1}`,
    url: asset.url,
    width: params.size.includes('1536') ? 1024 : 1200,
  }))
}

function normalizeImageResponse(
  payload: ImageResponsePayload,
  params: GenerationParams,
  taskId: string,
  createdAt: string,
): ImageAsset[] {
  if (payload.choices?.length) {
    return payload.choices.flatMap((choice, index) => {
      const url = choice.message?.images?.[0]?.image_url?.url
      if (!url) return []
      return buildImageAsset({
        createdAt,
        index,
        params,
        taskId,
        url,
      })
    })
  }

  return (payload.data ?? []).flatMap((item, index) => {
    const url = readImageUrl(item, params)

    if (!url) return []

    return buildImageAsset({
      createdAt,
      index,
      params,
      prompt: item.revised_prompt || params.prompt,
      taskId,
      url,
    })
  })
}

function buildImageAsset({
  createdAt,
  index,
  params,
  prompt = params.prompt,
  taskId,
  url,
}: {
  createdAt: string
  index: number
  params: GenerationParams
  prompt?: string
  taskId: string
  url: string
}): ImageAsset {
  return {
    id: createClientId('asset'),
    taskId,
    url,
    title: `${params.mode === 'generate' ? 'Generated' : params.mode === 'edit' ? 'Edited' : 'Continued'} ${index + 1}`,
    prompt,
    mode: params.mode,
    createdAt,
    width: params.size.includes('1536') ? 1024 : 1200,
    height: params.size.includes('1536') ? 1536 : 900,
  }
}

function readImageUrl(item: NonNullable<ImageResponsePayload['data']>[number], params: GenerationParams) {
  const format = normalizeOutputFormat(item.output_format ?? params.outputFormat)
  const dataUrl = item.data_url || item.dataUrl
  if (dataUrl?.startsWith('data:image/')) return dataUrl

  const base64 = item.b64_json || item.b64Json || item.base64 || item.image_base64
  if (base64) {
    const cleanBase64 = base64.startsWith('data:image/') ? base64.split(',')[1] : base64
    return `data:image/${format};base64,${cleanBase64}`
  }

  const image = item.image
  if (image?.startsWith('data:image/')) return image
  if (image && looksLikeBase64(image)) return `data:image/${format};base64,${image}`

  const url = item.url || item.image_url || item.imageUrl
  if (!url) return undefined
  if (url.startsWith('/')) return `/api/hono${url}`
  return url
}

function looksLikeBase64(value: string) {
  return value.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(value)
}

function normalizeOutputFormat(format: string) {
  const normalized = format.trim().toLowerCase()
  if (normalized === 'jpg') return 'jpeg'
  return normalized || 'png'
}

function readApiError(payload: ImageResponsePayload, status: number) {
  if (payload.error?.message) return payload.error.message
  if (payload.error?.code) return `${payload.error.code} (${status})`
  return `图像接口请求失败 (${status})。`
}

function describeImagePayload(payload: ImageResponsePayload) {
  const first = payload.data?.[0]
  const firstChoice = payload.choices?.[0]
  if (firstChoice) return `首个 choice 字段包含：${Object.keys(firstChoice).join(', ') || '无字段'}。`
  if (!first) return '返回 data 为空。'
  return `首个 data 字段包含：${Object.keys(first).join(', ') || '无字段'}。`
}
