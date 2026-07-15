import type { ApiClient } from './api'
import type { ProtocolEvent } from './protocol'
import type {
  Difficulty,
  GroundingSummary,
  LearnerDeliveryObservation,
  LiveSessionMetadata,
  Scenario,
} from './types'

export const VOICE_LIVE_PATH = '/api/voice-live'

export const voiceLiveSocketUrl = (location: { protocol: string; host: string }) =>
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${VOICE_LIVE_PATH}`

export const encodeAvatarSdp = (description: RTCSessionDescriptionInit) =>
  btoa(JSON.stringify(description))

export const decodeAvatarSdp = (encoded: string): RTCSessionDescriptionInit => {
  const decoded = JSON.parse(atob(encoded)) as { type?: unknown; sdp?: unknown }
  if (decoded.type !== 'answer' || typeof decoded.sdp !== 'string') {
    throw new Error('Azure returned an invalid avatar description.')
  }
  return { type: 'answer', sdp: decoded.sdp }
}

interface ConnectionCallbacks {
  dispatch: (event: ProtocolEvent) => void
  onAudioLevel: (level: number) => void
  onDebugEvent: (eventName: string) => void
  onDeliveryObservation: (observation: LearnerDeliveryObservation) => void
}

type VoiceLiveMessage = Record<string, unknown> & { type?: string }

const boundedString = (value: unknown, maximum = 4000) =>
  typeof value === 'string' ? value.slice(0, maximum) : ''

interface PcmSummary {
  sumSquares: number
  sampleCount: number
  peak: number
}

export const summarizePcm16 = (buffer: ArrayBuffer): PcmSummary => {
  const samples = new Int16Array(buffer)
  let sumSquares = 0
  let peak = 0
  for (const sample of samples) {
    const normalized = sample / 32768
    sumSquares += normalized * normalized
    peak = Math.max(peak, Math.abs(normalized))
  }
  return { sumSquares, sampleCount: samples.length, peak }
}

const toDbfs = (amplitude: number) =>
  amplitude > 0 ? Math.max(-96, 20 * Math.log10(amplitude)) : null

export const parseGroundingSummary = (value: unknown): GroundingSummary | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const mode = boundedString(candidate.mode, 40)
  const datasetId = boundedString(candidate.datasetId, 120)
  const queryBasis = boundedString(candidate.queryBasis, 40)
  if (
    mode !== 'synthetic-local' ||
    !datasetId ||
    (queryBasis !== 'scenario' && queryBasis !== 'learner-turns') ||
    !Array.isArray(candidate.sources)
  ) return undefined
  const sources = candidate.sources.slice(0, 3).flatMap((source) => {
    if (!source || typeof source !== 'object') return []
    const item = source as Record<string, unknown>
    const id = boundedString(item.id, 80)
    const title = boundedString(item.title, 160)
    return id && title ? [{ id, title }] : []
  })
  return { mode, datasetId, queryBasis, sources }
}

const validIceServers = (value: unknown): RTCIceServer[] => {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const item = candidate as Record<string, unknown>
    const urls = Array.isArray(item.urls)
      ? item.urls.filter((url): url is string => typeof url === 'string').slice(0, 8)
      : typeof item.urls === 'string'
        ? item.urls
        : null
    if (!urls || (Array.isArray(urls) && urls.length === 0)) return []
    return [
      {
        urls,
        username: boundedString(item.username, 512) || undefined,
        credential: boundedString(item.credential, 512) || undefined,
      },
    ]
  })
}

export class VoiceLiveConnection {
  private readonly api: ApiClient
  private readonly callbacks: ConnectionCallbacks
  private socket: WebSocket | null = null
  private peer: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private remoteStream: MediaStream | null = null
  private videoElement: HTMLVideoElement | null = null
  private audioContext: AudioContext | null = null
  private audioSource: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private silentGain: GainNode | null = null
  private remoteAudioSource: MediaStreamAudioSourceNode | null = null
  private remoteAnalyser: AnalyserNode | null = null
  private remoteSilentGain: GainNode | null = null
  private remoteLevelTimer: number | null = null
  private session: LiveSessionMetadata | null = null
  private readyResolve: ((session: LiveSessionMetadata) => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readyTimer: number | null = null
  private activeLearnerId: string | null = null
  private activeResponseId: string | null = null
  private assistantItems = new Set<string>()
  private sequence = 0
  private generation = 1
  private muted = false
  private readySent = false
  private closed = false
  private pendingResponseAudioAt: number | null = null
  private pendingResponseSignalAt: number | null = null
  private pendingInterruptionStopAt: number | null = null
  private interruptionWasAudible = false
  private interruptionQuietSamples = 0
  private remoteAudioAudible = false
  private activeDelivery: {
    itemId: string
    startedAt: number
    sumSquares: number
    sampleCount: number
    peak: number
  } | null = null

  constructor(api: ApiClient, callbacks: ConnectionCallbacks) {
    this.api = api
    this.callbacks = callbacks
  }

  async connect(
    scenario: Scenario,
    difficulty: Difficulty,
    videoElement: HTMLVideoElement,
  ): Promise<LiveSessionMetadata> {
    this.closed = false
    this.videoElement = videoElement
    this.callbacks.dispatch({
      type: 'connection-state',
      generation: this.generation,
      status: 'preparing',
    })
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    for (const track of this.localStream.getAudioTracks()) track.enabled = false

    this.callbacks.dispatch({
      type: 'connection-state',
      generation: this.generation,
      status: 'connecting',
    })
    const socket = new WebSocket(voiceLiveSocketUrl(window.location))
    this.socket = socket
    socket.addEventListener('message', this.handleSocketMessage)
    socket.addEventListener('close', this.handleSocketClose)
    socket.addEventListener('error', this.handleSocketError)
    await this.waitForSocket(socket)

    const ready = new Promise<LiveSessionMetadata>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.readyTimer = window.setTimeout(
        () => this.fail(new Error('The Azure avatar took too long to connect.')),
        45_000,
      )
    })
    socket.send(
      JSON.stringify({
        type: 'start_session',
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
        difficulty,
      }),
    )
    return ready
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (!this.readySent) return
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted
  }

  releaseForNavigation(): void {
    void this.close()
    void this.api.resetRealtimeSession(true)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'stop_session' }))
      this.socket.close(1000)
    }
    this.socket?.removeEventListener('message', this.handleSocketMessage)
    this.socket?.removeEventListener('close', this.handleSocketClose)
    this.socket?.removeEventListener('error', this.handleSocketError)
    this.socket = null
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.readyReject?.(new Error('Voice session closed.'))
    this.readyResolve = null
    this.readyReject = null

    this.worklet?.disconnect()
    if (this.worklet) this.worklet.port.onmessage = null
    this.worklet = null
    this.audioSource?.disconnect()
    this.audioSource = null
    this.silentGain?.disconnect()
    this.silentGain = null
    this.remoteAudioSource?.disconnect()
    this.remoteAudioSource = null
    this.remoteAnalyser?.disconnect()
    this.remoteAnalyser = null
    this.remoteSilentGain?.disconnect()
    this.remoteSilentGain = null
    if (this.remoteLevelTimer !== null) window.clearInterval(this.remoteLevelTimer)
    this.remoteLevelTimer = null
    if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close()
    this.audioContext = null
    for (const track of this.localStream?.getTracks() ?? []) track.stop()
    for (const track of this.remoteStream?.getTracks() ?? []) track.stop()
    this.localStream = null
    this.remoteStream = null
    this.peer?.removeEventListener('connectionstatechange', this.handlePeerState)
    this.peer?.close()
    this.peer = null
    if (this.videoElement) {
      this.videoElement.pause()
      this.videoElement.srcObject = null
    }
    this.videoElement = null
    this.callbacks.onAudioLevel(0)
    this.activeDelivery = null
    this.pendingResponseAudioAt = null
    this.pendingResponseSignalAt = null
    this.pendingInterruptionStopAt = null
    this.interruptionWasAudible = false
    this.interruptionQuietSamples = 0
    this.remoteAudioAudible = false
    this.generation += 1
  }

  private async waitForSocket(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const opened = () => {
        socket.removeEventListener('error', failed)
        resolve()
      }
      const failed = () => {
        socket.removeEventListener('open', opened)
        reject(new Error('The secure voice connection could not open.'))
      }
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed, { once: true })
    })
  }

  private readonly handleSocketMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string' || event.data.length > 128_000) return
    void this.processMessage(event.data).catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error('Invalid avatar response.'))
    })
  }

  private async processMessage(raw: string): Promise<void> {
    const message = JSON.parse(raw) as VoiceLiveMessage
    const messageType = boundedString(message.type, 120)
    if (!messageType) return
    this.callbacks.onDebugEvent(`voice-live.${messageType}`)

    if (messageType === 'session_started') {
      this.session = {
        sessionId: boundedString(message.sessionId, 160),
        modelDeployment: boundedString(message.model, 160) || 'gpt-realtime-1.5',
        transcriptionDeployment:
          boundedString(message.transcriptionModel, 160) || 'azure-speech',
        grounding: parseGroundingSummary(message.grounding),
      }
    } else if (messageType === 'ice_servers') {
      await this.setupAvatar(validIceServers(message.iceServers))
    } else if (messageType === 'avatar_sdp_answer') {
      if (!this.peer) throw new Error('Avatar negotiation arrived out of order.')
      await this.peer.setRemoteDescription(
        decodeAvatarSdp(boundedString(message.serverSdp, 128_000)),
      )
    } else if (messageType === 'speech_started') {
      this.sequence += 1
      if (this.activeResponseId) {
        this.pendingInterruptionStopAt = performance.now()
        this.interruptionWasAudible = this.remoteAudioAudible
        this.interruptionQuietSamples = 0
      }
      this.activeLearnerId =
        boundedString(message.itemId, 160) || `voice-live-learner-${this.sequence}`
      this.activeDelivery = {
        itemId: this.activeLearnerId,
        startedAt: performance.now(),
        sumSquares: 0,
        sampleCount: 0,
        peak: 0,
      }
      this.callbacks.dispatch({
        type: 'speech-started',
        generation: this.generation,
        itemId: this.activeLearnerId,
      })
    } else if (messageType === 'speech_stopped') {
      const itemId =
        this.activeLearnerId ||
        boundedString(message.itemId, 160) ||
        `voice-live-learner-${this.sequence}`
      this.callbacks.dispatch({
        type: 'speech-stopped',
        generation: this.generation,
        itemId,
      })
      this.finishDeliveryObservation(itemId)
      this.pendingResponseAudioAt = performance.now()
      this.pendingResponseSignalAt = this.pendingResponseAudioAt
    } else if (messageType === 'transcript_done' && message.role === 'user') {
      const itemId =
        this.activeLearnerId ||
        boundedString(message.itemId, 160) ||
        `voice-live-learner-${this.sequence}`
      this.callbacks.dispatch({
        type: 'learner-transcript',
        generation: this.generation,
        itemId,
        transcript: boundedString(message.transcript),
      })
      this.activeLearnerId = null
    } else if (messageType === 'transcript_delta' && message.role === 'assistant') {
      this.relayAssistantTranscript(message)
    } else if (messageType === 'transcript_done' && message.role === 'assistant') {
      const itemId = boundedString(message.itemId, 160)
      if (itemId && !this.assistantItems.has(itemId)) {
        this.relayAssistantTranscript({ ...message, delta: message.transcript })
      }
    } else if (messageType === 'response_done') {
      const responseId = boundedString(message.responseId, 160) || this.activeResponseId
      if (responseId) {
        this.callbacks.dispatch({
          type: 'avatar-output-stopped',
          generation: this.generation,
          responseId,
        })
      }
      this.activeResponseId = null
    } else if (messageType === 'session_error') {
      throw new Error(boundedString(message.error) || 'The Azure voice session failed.')
    }
  }

  private relayAssistantTranscript(message: VoiceLiveMessage): void {
    this.sequence += 1
    const responseId =
      boundedString(message.responseId, 160) ||
      this.activeResponseId ||
      `voice-live-response-${this.sequence}`
    const itemId =
      boundedString(message.itemId, 160) || `voice-live-avatar-${this.sequence}`
    this.assistantItems.add(itemId)
    if (this.activeResponseId !== responseId && this.pendingResponseSignalAt !== null) {
      this.callbacks.dispatch({
        type: 'response-signal-latency',
        generation: this.generation,
        valueMs: performance.now() - this.pendingResponseSignalAt,
      })
      this.pendingResponseSignalAt = null
    }
    this.callbacks.dispatch({
      type: 'avatar-transcript-delta',
      generation: this.generation,
      itemId,
      responseId,
      delta: boundedString(message.delta),
    })
    if (this.activeResponseId !== responseId) {
      this.activeResponseId = responseId
      this.callbacks.dispatch({
        type: 'avatar-output-started',
        generation: this.generation,
        responseId,
      })
    }
  }

  private async setupAvatar(iceServers: RTCIceServer[]): Promise<void> {
    if (this.peer || this.closed) return
    const peer = new RTCPeerConnection({ iceServers })
    this.peer = peer
    this.remoteStream = new MediaStream()
    peer.addTransceiver('video', { direction: 'recvonly' })
    peer.addTransceiver('audio', { direction: 'recvonly' })
    peer.addEventListener('connectionstatechange', this.handlePeerState)
    peer.addEventListener('track', (event) => {
      const stream = this.remoteStream
      if (!stream) return
      if (!stream.getTracks().some((track) => track.id === event.track.id)) {
        stream.addTrack(event.track)
      }
      if (event.track.kind === 'audio') this.startRemoteAudioMonitor()
      if (this.videoElement) {
        this.videoElement.srcObject = stream
        this.videoElement.autoplay = true
        this.videoElement.playsInline = true
        void this.videoElement.play().catch(() => {
          this.callbacks.onDebugEvent('avatar.autoplay-blocked')
        })
      }
    })

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await this.waitForIceGathering(peer)
    if (!peer.localDescription || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Avatar negotiation could not create an offer.')
    }
    this.socket.send(
      JSON.stringify({
        type: 'avatar_sdp_offer',
        clientSdp: encodeAvatarSdp({
          type: peer.localDescription.type,
          sdp: peer.localDescription.sdp,
        }),
      }),
    )
  }

  private async waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === 'complete') return
    await new Promise<void>((resolve) => {
      const completed = () => {
        if (peer.iceGatheringState !== 'complete') return
        window.clearTimeout(timeout)
        peer.removeEventListener('icegatheringstatechange', completed)
        resolve()
      }
      const timeout = window.setTimeout(() => {
        peer.removeEventListener('icegatheringstatechange', completed)
        resolve()
      }, 10_000)
      peer.addEventListener('icegatheringstatechange', completed)
    })
  }

  private readonly handlePeerState = () => {
    const state = this.peer?.connectionState
    this.callbacks.onDebugEvent(`avatar-peer.${state ?? 'unknown'}`)
    if (state === 'connected') void this.completeAvatarConnection()
    if (state === 'disconnected') {
      this.callbacks.dispatch({
        type: 'connection-state',
        generation: this.generation,
        status: 'reconnecting',
      })
    }
    if (state === 'failed') this.fail(new Error('The Azure avatar media connection failed.'))
  }

  private async completeAvatarConnection(): Promise<void> {
    if (this.readySent || this.closed) return
    this.readySent = true
    await this.startAudioCapture()
    this.startRemoteAudioMonitor()
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !this.muted
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('The secure voice connection closed during avatar setup.')
    }
    this.socket.send(JSON.stringify({ type: 'avatar_ready' }))
    this.callbacks.dispatch({
      type: 'connection-state',
      generation: this.generation,
      status: 'listening',
    })
    const session = this.session ?? {
      sessionId: 'voice-live',
      modelDeployment: 'gpt-realtime-1.5',
      transcriptionDeployment: 'azure-speech',
    }
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.readyResolve?.(session)
    this.readyResolve = null
    this.readyReject = null
  }

  private async startAudioCapture(): Promise<void> {
    if (!this.localStream || this.audioContext) return
    const context = new AudioContext()
    this.audioContext = context
    await context.audioWorklet.addModule('/pcm-capture-worklet.js')
    const source = context.createMediaStreamSource(this.localStream)
    const worklet = new AudioWorkletNode(context, 'pcm16-capture')
    const silentGain = context.createGain()
    silentGain.gain.value = 0
    source.connect(worklet)
    worklet.connect(silentGain)
    silentGain.connect(context.destination)
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      this.recordPcmSummary(event.data)
      if (
        this.socket?.readyState === WebSocket.OPEN &&
        this.socket.bufferedAmount < 256_000 &&
        event.data.byteLength > 0
      ) {
        this.socket.send(event.data)
      }
    }
    this.audioSource = source
    this.worklet = worklet
    this.silentGain = silentGain
    if (context.state === 'suspended') await context.resume()
  }

  private recordPcmSummary(buffer: ArrayBuffer): void {
    const active = this.activeDelivery
    if (!active) return
    const summary = summarizePcm16(buffer)
    active.sumSquares += summary.sumSquares
    active.sampleCount += summary.sampleCount
    active.peak = Math.max(active.peak, summary.peak)
  }

  private startRemoteAudioMonitor(): void {
    const context = this.audioContext
    const stream = this.remoteStream
    if (
      !context ||
      !stream ||
      !stream.getAudioTracks().length ||
      this.remoteAudioSource
    ) return

    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    const silentGain = context.createGain()
    analyser.fftSize = 256
    silentGain.gain.value = 0
    source.connect(analyser)
    analyser.connect(silentGain)
    silentGain.connect(context.destination)
    const samples = new Float32Array(analyser.fftSize)
    this.remoteLevelTimer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let sumSquares = 0
      for (const sample of samples) sumSquares += sample * sample
      const rms = Math.sqrt(sumSquares / samples.length)
      const audible = rms >= 0.008
      this.remoteAudioAudible = audible
      if (audible && this.pendingResponseAudioAt !== null) {
        this.callbacks.dispatch({
          type: 'response-audio-latency',
          generation: this.generation,
          valueMs: performance.now() - this.pendingResponseAudioAt,
        })
        this.pendingResponseAudioAt = null
      }
      if (this.pendingInterruptionStopAt === null) return
      if (audible) {
        this.interruptionWasAudible = true
        this.interruptionQuietSamples = 0
        return
      }
      if (!this.interruptionWasAudible) return
      this.interruptionQuietSamples += 1
      if (this.interruptionQuietSamples < 3) return
      this.callbacks.dispatch({
        type: 'interruption-stop-latency',
        generation: this.generation,
        valueMs: performance.now() - this.pendingInterruptionStopAt,
      })
      this.pendingInterruptionStopAt = null
      this.interruptionWasAudible = false
      this.interruptionQuietSamples = 0
    }, 20)
    this.remoteAudioSource = source
    this.remoteAnalyser = analyser
    this.remoteSilentGain = silentGain
  }

  private finishDeliveryObservation(itemId: string): void {
    const active = this.activeDelivery
    if (!active) return
    const rms = active.sampleCount
      ? Math.sqrt(active.sumSquares / active.sampleCount)
      : 0
    this.callbacks.onDeliveryObservation({
      itemId,
      durationMs: Math.max(0, Math.round(performance.now() - active.startedAt)),
      meanDbfs: toDbfs(rms),
      peakDbfs: toDbfs(active.peak),
    })
    this.activeDelivery = null
  }

  private readonly handleSocketClose = () => {
    if (!this.closed) this.fail(new Error('The secure voice connection closed.'))
  }

  private readonly handleSocketError = () => {
    if (!this.closed) this.fail(new Error('The secure voice connection failed.'))
  }

  private fail(error: Error): void {
    if (this.closed) return
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.readyReject?.(error)
    this.readyResolve = null
    this.readyReject = null
    this.callbacks.dispatch({
      type: 'connection-state',
      generation: this.generation,
      status: 'error',
    })
  }
}