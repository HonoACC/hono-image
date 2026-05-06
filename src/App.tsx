import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Empty,
  Form,
  Image,
  Layout,
  Modal,
  RadioGroup,
  Select,
  Space,
  Tag,
  TextArea,
  Toast,
  Typography,
  Upload,
} from '@douyinfe/semi-ui'
import {
  IconDownload,
  IconGallery,
  IconHistory,
  IconImage,
  IconPlay,
  IconRefresh,
} from '@douyinfe/semi-icons'
import { ArrowRight, ImagePlus, KeyRound, Sparkles } from 'lucide-react'
import './App.css'
import { buildImageTaskDebug, createImageTaskWithProgress, listModels } from './services/imageApi'
import type { ApiSettings, GenerationParams, ImageApiMode, ImageAsset, ImageMode, ImageModel, ImageTask, ImageTaskDebug } from './types/image'

const { Header, Content, Sider } = Layout
const { Title, Text, Paragraph } = Typography

const modeOptions = [
  { value: 'generate', label: '文生图', extra: '从提示词生成新图' },
  { value: 'edit', label: '图像修改', extra: '上传参考图后重绘' },
  { value: 'continue', label: '连续生图', extra: '基于结果继续迭代' },
] satisfies Array<{ value: ImageMode; label: string; extra: string }>

const sizeOptions = ['auto', '1024x1024', '1024x1536', '1536x1024']
const qualityOptions = ['auto', 'medium', 'high']
const formatOptions = ['png', 'jpeg', 'webp']
const apiModeOptions: Array<{ label: string; value: ImageApiMode }> = [
  { label: 'Images API', value: 'images' },
  { label: 'Lobe Chat Image', value: 'chat-image' },
]
const defaultBaseUrl = 'https://api.honoacc.com'

function getModeLabel(mode: ImageMode) {
  return modeOptions.find((item) => item.value === mode)?.label ?? mode
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('图片读取失败。'))
      }
    }
    reader.onerror = () => reject(new Error('图片读取失败。'))
    reader.readAsDataURL(file)
  })
}

function isUpstreamSixtySecondClose(debug?: ImageTaskDebug) {
  const elapsed = debug?.elapsed ?? 0
  const cause = debug?.error?.details?.cause
  return elapsed >= 55_000 && elapsed <= 70_000 && String(cause || '').includes('other side closed')
}

function summarizeFailure(error: unknown, debug?: ImageTaskDebug) {
  if (isUpstreamSixtySecondClose(debug)) {
    return '上游在约 60 秒关闭了同步图片请求连接。这类长任务需要后端提供真正的异步任务查询，或调大上游网关读超时。'
  }
  return error instanceof Error ? error.message : '图像任务失败。'
}

function App() {
  const [mode, setMode] = useState<ImageMode>('generate')
  const [models] = useState<ImageModel[]>(() => [])
  const [loadedModels, setLoadedModels] = useState<ImageModel[]>([])
  const [apiMode, setApiMode] = useState<ImageApiMode>('images')
  const [model, setModel] = useState('gpt-image-2')
  const [prompt, setPrompt] = useState('A cinematic product image of a matte black API gateway device on a clean workstation, precise lighting, production ready.')
  const [size, setSize] = useState('auto')
  const [quality, setQuality] = useState('auto')
  const [outputFormat, setOutputFormat] = useState('png')
  const [count, setCount] = useState(1)
  const [tasks, setTasks] = useState<ImageTask[]>([])
  const [selectedAsset, setSelectedAsset] = useState<ImageAsset | undefined>()
  const [isGenerating, setIsGenerating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [lastRun, setLastRun] = useState<{
    status: 'idle' | 'running' | 'succeeded' | 'failed'
    message: string
  }>({
    status: 'idle',
    message: '等待第一次请求。',
  })
  const [lastDebug, setLastDebug] = useState<ImageTaskDebug | undefined>()
  const [draftBaseUrl, setDraftBaseUrl] = useState(defaultBaseUrl)
  const [draftApiKey, setDraftApiKey] = useState('')
  const [apiSettings, setApiSettings] = useState<ApiSettings>({
    baseUrl: defaultBaseUrl,
    apiKey: '',
  })

  useEffect(() => {
    listModels().then((items) => {
      setLoadedModels(items)
      if (!model && items[0]) setModel(items[0].id)
    })
  }, [model])

  const allAssets = tasks.flatMap((task) => task.assets)
  const activeModels = loadedModels.length ? loadedModels : models

  const canSubmit = prompt.trim().length > 0 && !isGenerating
  const requiresReference = mode !== 'generate'
  const hasApiKey = apiSettings.apiKey.trim().length > 0
  const promptLength = prompt.trim().length

  async function handleGenerate() {
    if (requiresReference && !selectedAsset) {
      Toast.warning('请选择一张结果图作为参考图，或先完成一次文生图。')
      return
    }
    if (!prompt.trim()) {
      Toast.warning('请输入提示词。')
      return
    }
    if (!hasApiKey) {
      setSettingsOpen(true)
      Toast.warning('请输入后端 API 令牌。')
      return
    }

    setIsGenerating(true)
    setLastRun({
      status: 'running',
      message: `正在提交本地异步任务，后台将请求 ${apiSettings.baseUrl}${mode === 'generate' ? '/v1/images/generations' : '/v1/images/edits'}。`,
    })
    let latestRequestDebug: ImageTaskDebug | undefined
    try {
      const params: GenerationParams = {
        apiMode,
        mode,
        model,
        prompt: prompt.trim(),
        size,
        quality,
        outputFormat,
        count,
        referenceImages: selectedAsset ? [selectedAsset] : [],
        parentAssetId: selectedAsset?.id,
      }
      const debug = buildImageTaskDebug(params, apiSettings)
      latestRequestDebug = debug
      setLastDebug(debug)
      const task = await createImageTaskWithProgress(params, apiSettings, (event) => {
        latestRequestDebug = {
          endpoint: event.target || latestRequestDebug?.endpoint || debug.endpoint,
          localEndpoint: latestRequestDebug?.localEndpoint || debug.localEndpoint,
          taskId: event.id,
          taskStatus: event.status,
          elapsed: event.elapsed,
          statusCode: event.statusCode,
          upstreamTaskId: event.upstreamTaskId,
          upstreamTaskStatusUrl: event.upstreamTaskStatusUrl,
          error: event.error,
          payload: latestRequestDebug?.payload || debug.payload,
        }
        setLastDebug((current) => ({
          endpoint: event.target || current?.endpoint || debug.endpoint,
          localEndpoint: current?.localEndpoint || debug.localEndpoint || '/api/image-tasks',
          taskId: event.id,
          taskStatus: event.status,
          elapsed: event.elapsed,
          statusCode: event.statusCode,
          upstreamTaskId: event.upstreamTaskId,
          upstreamTaskStatusUrl: event.upstreamTaskStatusUrl,
          error: event.error,
          payload: current?.payload || debug.payload,
        }))
        setLastRun({
          status: 'running',
          message: [
            `本地任务 ${event.id}：${event.status}`,
            typeof event.elapsed === 'number' ? `elapsed: ${event.elapsed}ms` : '',
            event.statusCode ? `status: ${event.statusCode}` : '',
          ].filter(Boolean).join('，'),
        })
      })
      setTasks((current) => [task, ...current])
      setSelectedAsset(task.assets[0])
      setLastRun({
        status: 'succeeded',
        message: `本地异步任务完成，已生成 ${task.assets.length} 张图片。`,
      })
      Toast.success('图像任务已完成。')
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '图像任务失败。'
      const message = summarizeFailure(error, latestRequestDebug)
      const failedTask: ImageTask = {
        id: latestRequestDebug?.taskId || `failed_${crypto.randomUUID()}`,
        mode,
        model,
        prompt: prompt.trim(),
        status: 'failed',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: rawMessage,
        assets: [],
      }
      setTasks((current) => [failedTask, ...current])
      setLastRun({
        status: 'failed',
        message,
      })
      Toast.error(message)
    } finally {
      setIsGenerating(false)
    }
  }

  function continueFrom(asset: ImageAsset) {
    setSelectedAsset(asset)
    setMode('continue')
    setPrompt(`Continue from "${asset.title}". Keep the strongest composition and improve the lighting, texture, and production detail.`)
  }

  async function handleUploadFile(file: File) {
    try {
      const url = await readFileAsDataUrl(file)
      setSelectedAsset({
        id: `upload_${crypto.randomUUID()}`,
        url,
        title: file.name || 'Uploaded reference',
        prompt: 'Uploaded reference image',
        mode: 'edit',
        createdAt: new Date().toISOString(),
        width: 0,
        height: 0,
      })
      Toast.success('参考图已载入。')
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : '图片读取失败。')
    }
    return false
  }

  function saveSettings() {
    const normalizedBaseUrl = draftBaseUrl.trim().replace(/\/+$/, '') || defaultBaseUrl
    const trimmedKey = draftApiKey.trim()
    if (!trimmedKey) {
      Toast.warning('请输入 API 令牌。')
      return
    }
    setApiSettings({
      baseUrl: normalizedBaseUrl,
      apiKey: trimmedKey,
    })
    setDraftBaseUrl(normalizedBaseUrl)
    setDraftApiKey(trimmedKey)
    setSettingsOpen(false)
    Toast.success('API 设置已保存到当前浏览器会话。')
  }

  return (
    <Layout className="app-shell">
      <Header className="topbar">
        <div className="brand-mark">
          <Sparkles size={18} />
        </div>
        <div>
          <Title heading={4} className="brand-title">Hono Image Lab</Title>
          <Text type="tertiary">独立图像生成工作台，先跑通页面和 API 边界</Text>
        </div>
        <div className="topbar-actions">
          <Tag color="green" prefixIcon={<IconPlay />}>API Proxy</Tag>
          <Tag color={hasApiKey ? 'blue' : 'amber'} prefixIcon={<KeyRound size={13} />}>
            {hasApiKey ? '令牌已设置' : '需要令牌'}
          </Tag>
          <Button theme="borderless" icon={<KeyRound size={15} />} onClick={() => setSettingsOpen(true)}>
            API 设置
          </Button>
        </div>
      </Header>

      <Layout className="workspace">
        <Sider className="control-panel">
          <section>
            <Text strong>工作模式</Text>
            <div className="mode-list">
              {modeOptions.map((item) => (
                <button
                  key={item.value}
                  className={`mode-card ${mode === item.value ? 'active' : ''}`}
                  type="button"
                  onClick={() => setMode(item.value)}
                >
                  <span>{item.label}</span>
                  <small>{item.extra}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="panel-section">
            <Text strong>API 连接</Text>
            <div className="api-status">
              <span>Base URL</span>
              <strong>{apiSettings.baseUrl}</strong>
              <small>{hasApiKey ? `令牌尾号 ${apiSettings.apiKey.slice(-4)}` : '未输入 API 令牌'}</small>
              <Button size="small" theme="borderless" onClick={() => setSettingsOpen(true)}>修改</Button>
            </div>
          </section>

          <section className="panel-section">
            <Text strong>模型参数</Text>
            <Form className="compact-form" labelPosition="top">
              <Form.Select label="接口模式" field="apiMode" initValue={apiMode} onChange={(value) => setApiMode(value as ImageApiMode)}>
                {apiModeOptions.map((item) => (
                  <Select.Option key={item.value} value={item.value}>{item.label}</Select.Option>
                ))}
              </Form.Select>
              <Form.Select label="模型" field="model" initValue={model} onChange={(value) => setModel(String(value))}>
                {activeModels.map((item) => (
                  <Select.Option key={item.id} value={item.id}>{item.label}</Select.Option>
                ))}
              </Form.Select>
              <Form.Select label="尺寸" field="size" initValue={size} onChange={(value) => setSize(String(value))}>
                {sizeOptions.map((item) => (
                  <Select.Option key={item} value={item}>{item}</Select.Option>
                ))}
              </Form.Select>
              <Form.Select label="质量" field="quality" initValue={quality} onChange={(value) => setQuality(String(value))}>
                {qualityOptions.map((item) => (
                  <Select.Option key={item} value={item}>{item}</Select.Option>
                ))}
              </Form.Select>
              <Form.Select label="格式" field="format" initValue={outputFormat} onChange={(value) => setOutputFormat(String(value))}>
                {formatOptions.map((item) => (
                  <Select.Option key={item} value={item}>{item}</Select.Option>
                ))}
              </Form.Select>
              <div className="form-row-label">数量</div>
              <RadioGroup
                type="button"
                buttonSize="small"
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
                options={[1, 2, 4].map((value) => ({ label: String(value), value }))}
              />
            </Form>
          </section>
        </Sider>

        <Content className="main-stage">
          <Card className="prompt-card" bodyStyle={{ padding: 0 }}>
            <div className="prompt-header">
              <div>
                <Text type="tertiary">{getModeLabel(mode)}</Text>
                <Title heading={3}>描述你要生成的图像</Title>
              </div>
              <Button icon={<IconRefresh />} theme="borderless" onClick={() => setPrompt('')}>清空</Button>
            </div>

            <TextArea
              autosize={{ minRows: 5, maxRows: 8 }}
              value={prompt}
              onChange={setPrompt}
              placeholder="输入图像主题、主体、风格、构图、光线、需要保留或修改的细节。"
            />
            <div className="prompt-note">
              建议用虚构会员卡、产品认证卡、活动通行证或普通产品图做稳定性测试；真实政府证件类提示词更容易触发上游风控或长时间审核。
            </div>

            <div className="reference-strip">
              <div>
                <Text strong>参考图</Text>
                <Paragraph type="tertiary" spacing="extended">
                  {selectedAsset ? selectedAsset.title : requiresReference ? '连续生图和图像修改需要选择一张参考图。' : '文生图可不选参考图。'}
                </Paragraph>
              </div>
              {selectedAsset ? (
                <div className="selected-reference">
                  <img src={selectedAsset.url} alt={selectedAsset.title} />
                  <Button size="small" onClick={() => setSelectedAsset(undefined)}>移除</Button>
                </div>
              ) : (
                <Upload
                  action=""
                  draggable
                  dragIcon={<ImagePlus size={22} />}
                  limit={1}
                  className="upload-box"
                  customRequest={({ fileInstance, onSuccess, onError }) => {
                    handleUploadFile(fileInstance)
                      .then(() => onSuccess({ ok: true }))
                      .catch(() => onError({ status: 400 }))
                  }}
                >
                  <Text>上传参考图</Text>
                </Upload>
              )}
            </div>

            <div className="submit-row">
              <Space>
                <Tag color="grey">{size}</Tag>
                <Tag color="grey">{quality}</Tag>
                <Tag color="grey">{outputFormat}</Tag>
                <Tag color={promptLength > 2000 ? 'amber' : 'grey'}>{promptLength} chars</Tag>
              </Space>
              <Button
                theme="solid"
                type="primary"
                icon={<IconImage />}
                loading={isGenerating}
                disabled={!canSubmit}
                onClick={handleGenerate}
              >
                开始生成
              </Button>
            </div>
            <div className={`run-status ${lastRun.status}`}>
              <span>{lastRun.status === 'running' ? '请求中' : lastRun.status === 'succeeded' ? '成功' : lastRun.status === 'failed' ? '失败' : '状态'}</span>
              <p>{lastRun.message}</p>
            </div>
            {lastDebug ? (
              <details className="debug-panel">
                <summary>请求调试信息</summary>
                <pre>{JSON.stringify(lastDebug, null, 2)}</pre>
              </details>
            ) : null}
          </Card>

          <section className="results-section">
            <div className="section-heading">
              <div>
                <Title heading={4}>生成结果</Title>
                <Text type="tertiary">请求经本地 Vite proxy 转发到你在 API 设置中填写的后端。</Text>
              </div>
              <Tag prefixIcon={<IconGallery />}>{allAssets.length} 张图片</Tag>
            </div>

            {allAssets.length ? (
              <div className="asset-grid">
                {allAssets.map((asset) => (
                  <Card key={asset.id} className={`asset-card ${selectedAsset?.id === asset.id ? 'selected' : ''}`} bodyStyle={{ padding: 0 }}>
                    <Image src={asset.url} alt={asset.title} width="100%" height={220} className="asset-image" />
                    <div className="asset-meta">
                      <div>
                        <Text strong>{asset.title}</Text>
                        <Text type="tertiary" size="small">{getModeLabel(asset.mode)} · {new Date(asset.createdAt).toLocaleTimeString()}</Text>
                      </div>
                      <Space>
                        <Button icon={<ArrowRight size={14} />} size="small" onClick={() => continueFrom(asset)}>继续</Button>
                        <Button icon={<IconDownload />} size="small" theme="borderless" />
                      </Space>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <Empty
                image={<IconGallery size="extra-large" />}
                title="还没有生成结果"
                description="先用文生图跑一次，再进入图像修改或连续生图。"
              />
            )}
          </section>
        </Content>

        <Sider className="history-panel">
          <div className="history-heading">
            <IconHistory />
            <Text strong>会话历史</Text>
          </div>
          {tasks.length ? (
            <div className="task-list">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  className={`task-item ${task.status}`}
                  type="button"
                  onClick={() => {
                    if (task.assets[0]) {
                      setSelectedAsset(task.assets[0])
                      return
                    }
                    setPrompt(task.prompt)
                    setMode(task.mode)
                  }}
                >
                  <span>{getModeLabel(task.mode)}</span>
                  <small>{task.prompt}</small>
                  <Tag color={task.status === 'failed' ? 'red' : 'green'} size="small">
                    {task.status === 'failed' ? 'failed' : `${task.assets.length} results`}
                  </Tag>
                  {task.error ? <small className="task-error">{task.error}</small> : null}
                </button>
              ))}
            </div>
          ) : (
            <Paragraph type="tertiary">生成任务会出现在这里，后续会接入持久化图库。</Paragraph>
          )}
        </Sider>
      </Layout>
      <Modal
        title="API 设置"
        visible={settingsOpen}
        onOk={saveSettings}
        onCancel={() => setSettingsOpen(false)}
        okText="保存"
        cancelText="取消"
        width={520}
      >
        <div className="settings-form">
          <label>
            <span>Base URL</span>
            <input
              value={draftBaseUrl}
              onChange={(event) => setDraftBaseUrl(event.target.value)}
              placeholder={defaultBaseUrl}
            />
          </label>
          <label>
            <span>API 令牌</span>
            <input
              type="password"
              value={draftApiKey}
              onChange={(event) => setDraftApiKey(event.target.value)}
              placeholder="输入后端站点生成的令牌"
              autoComplete="off"
            />
          </label>
          <Paragraph type="tertiary">
            令牌只保存在当前页面内存中。刷新页面后需要重新输入，避免把客户令牌写入项目文件或本地持久化存储。
          </Paragraph>
        </div>
      </Modal>
    </Layout>
  )
}

export default App
