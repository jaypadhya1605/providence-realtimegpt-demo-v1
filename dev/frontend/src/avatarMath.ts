export interface AvatarMotion {
  level: number
  mouthOpen: number
}

const clamp = (value: number, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))

export function computeAvatarMotion(
  previous: AvatarMotion,
  samples: readonly number[],
  reducedMotion = false,
): AvatarMotion {
  if (samples.length === 0) return { level: 0, mouthOpen: 0 }
  const energy = samples.reduce((sum, sample) => {
    const centered = clamp((sample - 128) / 128, -1, 1)
    return sum + centered * centered
  }, 0)
  const rms = clamp(Math.sqrt(energy / samples.length) * 2.8)
  const smoothing = rms > previous.level ? 0.72 : 0.2
  const level = clamp(previous.level + (rms - previous.level) * smoothing)
  return {
    level,
    mouthOpen: reducedMotion ? (level > 0.08 ? 0.55 : 0) : clamp(level * 1.1),
  }
}