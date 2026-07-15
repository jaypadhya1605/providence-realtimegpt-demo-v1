import { describe, expect, it } from 'vitest'
import {
  decodeAvatarSdp,
  encodeAvatarSdp,
  parseGroundingSummary,
  summarizePcm16,
  VOICE_LIVE_PATH,
  voiceLiveSocketUrl,
} from './voiceLive'

describe('Voice Live signaling', () => {
  it('uses a same-origin secure WebSocket in production', () => {
    expect(
      voiceLiveSocketUrl({ protocol: 'https:', host: 'app.example.test' }),
    ).toBe('wss://app.example.test/api/voice-live')
    expect(VOICE_LIVE_PATH).toBe('/api/voice-live')
  })

  it('round-trips the base64 JSON SDP contract used by Azure avatars', () => {
    const answer = { type: 'answer' as const, sdp: 'v=0\r\na=recvonly\r\n' }
    expect(decodeAvatarSdp(encodeAvatarSdp(answer))).toEqual(answer)
  })

  it('rejects a non-answer avatar description', () => {
    const invalid = btoa(JSON.stringify({ type: 'offer', sdp: 'v=0' }))
    expect(() => decodeAvatarSdp(invalid)).toThrow('invalid avatar description')
  })

  it('accepts only bounded public RAG source metadata', () => {
    const grounding = parseGroundingSummary({
      mode: 'synthetic-local',
      datasetId: 'empathyai-synthetic-v1',
      queryBasis: 'scenario',
      sources: [
        { id: 'REF-MARIA-001', title: 'Naming fear before explaining next steps' },
        { id: 'REF-MARIA-002', title: 'Generic reassurance leaves the concern unanswered' },
        { id: 'REF-MARIA-003', title: 'Repairing prognosis and palliative jargon' },
        { id: 'REF-MARIA-004', title: 'Must be dropped' },
      ],
      rawTranscript: 'must not be retained',
    })

    expect(grounding?.sources).toHaveLength(3)
    expect(grounding?.sources[0]).toEqual({
      id: 'REF-MARIA-001',
      title: 'Naming fear before explaining next steps',
    })
    expect(grounding).not.toHaveProperty('rawTranscript')
    expect(parseGroundingSummary({ mode: 'other', sources: [] })).toBeUndefined()
  })

  it('reduces PCM to aggregate energy without retaining samples', () => {
    const pcm = Int16Array.from([0, 16384, -16384, 32767])
    const summary = summarizePcm16(pcm.buffer)

    expect(summary.sampleCount).toBe(4)
    expect(summary.peak).toBeGreaterThan(0.99)
    expect(summary.sumSquares).toBeGreaterThan(1.4)
    expect(summary).not.toHaveProperty('samples')
  })
})