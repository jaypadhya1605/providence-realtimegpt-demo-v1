import type { ApiClient } from './api'
import type { ProtocolEvent } from './protocol'
import type { Difficulty, RealtimeSession, Scenario } from './types'

export const REALTIME_CALLS_PATH = '/openai/v1/realtime/calls?webrtcfilter=on'

export const realtimeCallsUrl = (endpoint: string) =>
  `${endpoint.replace(/\/$/, '')}${REALTIME_CALLS_PATH}`

interface ConnectionCallbacks {
  dispatch: (event: ProtocolEvent) => void
  onAudioLevel: (level: number) => void
  onDebugEvent: (eventName: string) => void
}

type RealtimeMessage = Record<string, unknown> & { type?: string; event_id?: string }

const boundedString = (value: unknown, maximum = 4000) =>
  typeof value === 'string' ? value.slice(0, maximum) : ''

export class AzureRealtimeConnection {
  private readonly api: ApiClient
  private readonly callbacks: ConnectionCallbacks
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private localStream: MediaStream | null = null
  private remoteStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private animationFrame: number | null = null
  private session: RealtimeSession | null = null
  private generation = 1
  private closed = false

  constructor(api: ApiClient, callbacks: ConnectionCallbacks) {
    this.api = api
    this.callbacks = callbacks
  }

  async connect(
    scenario: Scenario,
    difficulty: Difficulty,
    audioElement: HTMLAudioElement,
  ): Promise<RealtimeSession> {
    this.closed = false
    this.callbacks.dispatch({
      type: 'connection-state',
      generation: this.generation,
      status: 'preparing',
    })
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.callbacks.dispatch({
      type: 'connection-state',
      generation: this.generation,
      status: 'connecting',
    })
    const session = await this.api.createRealtimeSession(scenario, difficulty)
    this.session = session

    const peer = new RTCPeerConnection()
    this.peer = peer
    const channel = peer.createDataChannel('oai-events')
    this.channel = channel
    channel.addEventListener('message', this.handleMessage)
    channel.addEventListener('open', () => {
      this.callbacks.onDebugEvent('data-channel.open')
      channel.send(JSON.stringify({ type: 'response.create' }))
      this.updateConnectedState()
    })
    peer.addEventListener('connectionstatechange', this.handleConnectionState)
    peer.addEventListener('track', (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      this.remoteStream = stream
      audioElement.srcObject = stream
      audioElement.autoplay = true
      void audioElement.play()
      this.startMeter(stream)
      this.updateConnectedState()
    })
    for (const track of this.localStream.getTracks()) peer.addTrack(track, this.localStream)

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const answer = await fetch(realtimeCallsUrl(session.endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
      cache: 'no-store',
    })
    session.clientSecret = ''
    if (!answer.ok) throw new Error(`Realtime negotiation failed (${answer.status}).`)
    await peer.setRemoteDescription({ type: 'answer', sdp: await answer.text() })
    return session
  }

  setMuted(muted: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted
  }

  releaseForNavigation(): void {
    const sessionId = this.session?.sessionId
    this.session = null
    if (sessionId) void this.api.endRealtimeSession(sessionId, true)
  }

  async close(audioElement: HTMLAudioElement): Promise<void> {
    if (this.closed) return
    this.closed = true
    const sessionId = this.session?.sessionId
    this.session = null
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
    this.analyser?.disconnect()
    this.analyser = null
    if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close()
    this.audioContext = null
    this.channel?.removeEventListener('message', this.handleMessage)
    this.channel?.close()
    this.channel = null
    this.peer?.removeEventListener('connectionstatechange', this.handleConnectionState)
    this.peer?.close()
    this.peer = null
    for (const track of this.localStream?.getTracks() ?? []) track.stop()
    for (const track of this.remoteStream?.getTracks() ?? []) track.stop()
    this.localStream = null
    this.remoteStream = null
    audioElement.pause()
    audioElement.srcObject = null
    this.callbacks.onAudioLevel(0)
    this.generation += 1
    if (sessionId) {
      try {
        await this.api.endRealtimeSession(sessionId)
      } catch {
        // Local media cleanup is authoritative even when the release call cannot complete.
      }
    }
  }

  private updateConnectedState(): void {
    if (this.peer?.connectionState === 'connected' && this.channel?.readyState === 'open') {
      this.callbacks.dispatch({
        type: 'connection-state',
        generation: this.generation,
        status: 'listening',
      })
    }
  }

  private readonly handleConnectionState = () => {
    const state = this.peer?.connectionState
    this.callbacks.onDebugEvent(`peer.${state ?? 'unknown'}`)
    if (state === 'connected') this.updateConnectedState()
    if (state === 'disconnected') {
      this.callbacks.dispatch({
        type: 'connection-state',
        generation: this.generation,
        status: 'reconnecting',
      })
    }
    if (state === 'failed') {
      this.callbacks.dispatch({
        type: 'connection-state',
        generation: this.generation,
        status: 'error',
      })
    }
  }

  private readonly handleMessage = (message: MessageEvent<string>) => {
    if (typeof message.data !== 'string' || message.data.length > 65_536) return
    let event: RealtimeMessage
    try {
      event = JSON.parse(message.data) as RealtimeMessage
    } catch {
      this.callbacks.onDebugEvent('protocol.invalid-json')
      return
    }
    const eventType = boundedString(event.type, 120)
    if (!eventType) return
    this.callbacks.onDebugEvent(eventType)
    const eventId = boundedString(event.event_id, 160) || undefined
    const itemId = boundedString(event.item_id, 160)
    const responseId = boundedString(event.response_id, 160)
    const common = { generation: this.generation, eventId }

    if (eventType === 'input_audio_buffer.speech_started' && itemId) {
      this.callbacks.dispatch({ type: 'speech-started', itemId, ...common })
    } else if (eventType === 'input_audio_buffer.speech_stopped' && itemId) {
      this.callbacks.dispatch({ type: 'speech-stopped', itemId, ...common })
    } else if (eventType === 'conversation.item.input_audio_transcription.completed' && itemId) {
      this.callbacks.dispatch({
        type: 'learner-transcript',
        itemId,
        transcript: boundedString(event.transcript),
        ...common,
      })
    } else if (eventType === 'conversation.item.input_audio_transcription.failed' && itemId) {
      this.callbacks.dispatch({ type: 'learner-transcript-failed', itemId, ...common })
    } else if (eventType === 'response.output_audio_transcript.delta' && itemId && responseId) {
      this.callbacks.dispatch({
        type: 'avatar-transcript-delta',
        itemId,
        responseId,
        delta: boundedString(event.delta),
        ...common,
      })
    } else if (eventType === 'output_audio_buffer.started' && responseId) {
      this.callbacks.dispatch({ type: 'avatar-output-started', responseId, ...common })
    } else if (eventType === 'output_audio_buffer.stopped' && responseId) {
      this.callbacks.dispatch({ type: 'avatar-output-stopped', responseId, ...common })
    } else if (eventType === 'error') {
      this.callbacks.dispatch({ type: 'connection-state', status: 'error', ...common })
    }
  }

  private startMeter(stream: MediaStream): void {
    this.audioContext = new AudioContext()
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 256
    const source = this.audioContext.createMediaStreamSource(stream)
    source.connect(this.analyser)
    const samples = new Uint8Array(this.analyser.fftSize)
    const sample = () => {
      if (this.closed || !this.analyser) return
      this.analyser.getByteTimeDomainData(samples)
      const energy = samples.reduce((sum, value) => {
        const centered = (value - 128) / 128
        return sum + centered * centered
      }, 0)
      this.callbacks.onAudioLevel(Math.min(1, Math.sqrt(energy / samples.length) * 2.8))
      this.animationFrame = requestAnimationFrame(sample)
    }
    sample()
  }
}