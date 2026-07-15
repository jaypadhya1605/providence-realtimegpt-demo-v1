import { describe, expect, it } from 'vitest'
import { REALTIME_CALLS_PATH, realtimeCallsUrl } from './realtime'

describe('Azure Realtime endpoint', () => {
  it('uses the filtered GA calls endpoint without a preview API version', () => {
    const url = realtimeCallsUrl('https://demo.openai.azure.com/')
    expect(url).toBe(
      'https://demo.openai.azure.com/openai/v1/realtime/calls?webrtcfilter=on',
    )
    expect(REALTIME_CALLS_PATH).not.toContain('preview')
    expect(url).not.toContain('api-version')
  })
})