import type { CSSProperties } from 'react'
import type { ConversationStatus, Expression, Scenario } from './types'

interface AvatarProps {
  persona: Scenario['persona']
  expression: Expression
  status: ConversationStatus
  mouthOpen?: number
  compact?: boolean
}

export function Avatar({
  persona,
  expression,
  status,
  mouthOpen = 0,
  compact = false,
}: AvatarProps) {
  const safeMouth = Math.min(1, Math.max(0, Number.isFinite(mouthOpen) ? mouthOpen : 0))
  const style = {
    '--mouth-open': safeMouth,
    '--audio-level': `${Math.max(0.05, safeMouth)}`,
  } as CSSProperties

  return (
    <div
      className={`avatar avatar--${persona.toLowerCase()} ${compact ? 'avatar--compact' : ''}`}
      data-expression={expression}
      data-status={status}
      style={style}
    >
      <div className="avatar__halo" aria-hidden="true" />
      <svg
        className="avatar__art"
        viewBox="0 0 420 440"
        role="img"
        aria-label={`Illustrated synthetic avatar of ${persona}`}
      >
        <path className="avatar__shadow" d="M75 438c15-100 65-139 135-139s120 39 135 139H75Z" />
        <g className="avatar__body">
          <path className="avatar__shoulders" d="M86 440c9-89 56-132 124-132s115 43 124 132H86Z" />
          <path className="avatar__collar" d="m166 311 44 44 44-44-15-17h-58l-15 17Z" />
          <path className="avatar__neck" d="M178 270h64v55c-16 18-48 18-64 0v-55Z" />
        </g>
        <g className="avatar__head">
          <path className="avatar__ear" d="M119 187c-20-7-28 13-19 38 6 18 17 25 31 18l-12-56Z" />
          <path className="avatar__ear" d="M301 187c20-7 28 13 19 38-6 18-17 25-31 18l12-56Z" />
          <path className="avatar__face" d="M123 171c0-81 38-121 87-121s87 40 87 121v51c0 67-38 103-87 103s-87-36-87-103v-51Z" />
          <path className="avatar__hair avatar__hair--back" d="M117 181C96 93 139 31 211 31c72 0 114 59 91 153l-14-51c-41-5-83-31-106-54-11 25-28 45-55 59l-10 43Z" />
          <path className="avatar__hair avatar__hair--maria" d="M118 177c-12 28-13 80 4 117-27-26-35-67-27-111 4-25 12-44 26-59l-3 53Zm184 0c12 28 13 80-4 117 27-26 35-67 27-111-4-25-12-44-26-59l3 53Z" />
          <path className="avatar__hair avatar__hair--daniel" d="M116 155c11-78 53-124 104-121 50 3 75 31 88 84-46-2-77-19-104-46-19 26-48 49-88 55Z" />
          <path className="avatar__hair avatar__hair--aisha" d="M104 180c0-98 39-148 106-148s106 50 106 148l-24-30c-9-52-37-77-82-77s-73 25-82 77l-24 30Z" />
          <g className="avatar__brows">
            <path d="M151 174c16-9 33-9 47-1" />
            <path d="M222 173c14-8 31-8 47 1" />
          </g>
          <g className="avatar__eyes">
            <ellipse cx="174" cy="199" rx="16" ry="10" />
            <ellipse cx="246" cy="199" rx="16" ry="10" />
            <circle cx="176" cy="200" r="5" />
            <circle cx="244" cy="200" r="5" />
          </g>
          <path className="avatar__nose" d="M211 204c-5 22-7 35 5 39" />
          <ellipse
            className="avatar__mouth"
            cx="210"
            cy="270"
            rx={22 + safeMouth * 3}
            ry={3 + safeMouth * 13}
          />
          <path className="avatar__mouth-line" d="M188 269c15 7 29 7 44 0" />
        </g>
      </svg>
      {!compact && <span className="avatar__name">{persona}</span>}
    </div>
  )
}