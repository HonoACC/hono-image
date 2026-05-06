export type ImageMode = 'generate' | 'edit' | 'continue'

export type ImageTaskStatus = 'idle' | 'pending' | 'running' | 'succeeded' | 'failed'

export type ImageModel = {
  id: string
  label: string
  description: string
  supportsEdit: boolean
  supportsContinuation: boolean
}

export type GenerationParams = {
  apiMode: ImageApiMode
  mode: ImageMode
  model: string
  prompt: string
  size: string
  quality: string
  outputFormat: string
  count: number
  referenceImages: ImageAsset[]
  parentAssetId?: string
}

export type ImageTask = {
  id: string
  mode: ImageMode
  model: string
  prompt: string
  status: ImageTaskStatus
  createdAt: string
  completedAt?: string
  error?: string
  assets: ImageAsset[]
}

export type ImageAsset = {
  id: string
  taskId?: string
  url: string
  title: string
  prompt: string
  mode: ImageMode
  createdAt: string
  width: number
  height: number
}

export type ImageSession = {
  id: string
  title: string
  tasks: ImageTask[]
  selectedAssetId?: string
}

export type ApiSettings = {
  baseUrl: string
  apiKey: string
}

export type ImageApiMode = 'images' | 'chat-image'

export type ImageTaskDebug = {
  endpoint: string
  localEndpoint?: string
  taskId?: string
  taskStatus?: string
  elapsed?: number
  statusCode?: number
  upstreamTaskId?: string
  upstreamTaskStatusUrl?: string
  error?: {
    message?: string
    code?: string
    status?: number
    details?: Record<string, unknown>
  }
  payload: Record<string, unknown>
}
