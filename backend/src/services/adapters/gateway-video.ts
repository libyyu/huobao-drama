/**
 * 本地 AI Gateway 视频生成 Adapter（配套 C:\Workspace\ai-gateway）
 * 端点: POST /v1/videos 提交 → GET /v1/videos/{id} 轮询
 * 响应: { id, status: "queued" } -> { status: queued|processing|completed|failed, result_url, error }
 *
 * 限制：仅支持纯文本生成（T2V）。网关 video worker 只接受 prompt + 可选 base64
 * init_image，而本接口的 buildGenerateRequest 为同步签名，无法把参考 URL 拉取
 * 转码成 base64，故带参考素材的请求直接报错，避免静默降级。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

const DEFAULT_MODEL = 'wan2.1-1.3b'
const FPS = 16

/** aspectRatio → [width, height]，480p 档（Wan 1.3B 最佳分辨率档位） */
const RATIO_SIZE: Record<string, [number, number]> = {
  '16:9': [832, 480],
  '9:16': [480, 832],
  '1:1': [640, 640],
  '4:3': [640, 480],
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

export class GatewayVideoAdapter implements VideoProviderAdapter {
  provider = 'gateway'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    if (refImages.length || refVideos.length || refAudios.length) {
      throw new Error('本地 AI Gateway 暂不支持参考图/视频/音频，请使用纯文本生成模式')
    }

    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('本地 AI Gateway 需要 prompt')

    // 'adaptive' 及未知比例回退 16:9
    const ratioKey = RATIO_SIZE[record.aspectRatio || ''] ? record.aspectRatio! : '16:9'
    let [width, height] = RATIO_SIZE[ratioKey]
    if (record.resolution === '720p') {
      // 480p 档放大 1.5x 得 720p 档
      width = Math.round(width * 1.5)
      height = Math.round(height * 1.5)
    }

    const duration = Math.min(10, Math.max(1, Math.round(Number(record.duration || 5))))

    const body: any = {
      model: record.model || config.model || DEFAULT_MODEL,
      prompt,
      duration,
      fps: FPS,
      width,
      height,
    }
    if (record.seed != null && Number.isFinite(Number(record.seed))) {
      body.seed = Number(record.seed)
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'),
      method: 'POST',
      headers,
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const errMsg = result?.error?.message || result?.detail
    if (errMsg) throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg))
    if (result?.id) {
      return { isAsync: true, taskId: result.id }
    }
    throw new Error('No job id in gateway response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const headers: Record<string, string> = {}
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${taskId}`),
      method: 'GET',
      headers,
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result?.status
    if (status === 'completed') {
      return { status: 'completed', videoUrl: result.result_url || undefined }
    }
    if (status === 'failed') {
      return { status: 'failed', error: result.error || 'Video generation failed' }
    }
    // queued / processing / 未知 → 统统视为处理中
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result?.result_url || null
  }
}
