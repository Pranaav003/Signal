export default function KeywordSetItem({
  keywordSet,
  isActive,
  onClick,
  unseenCount,
}) {
  const text = keywordSet.product_description ?? ''
  const truncated = text.length > 35 ? `${text.slice(0, 35)}…` : text

  return (
    <button
      type="button"
      onClick={() => onClick(keywordSet.id)}
      className="signal-btn-focus relative w-full cursor-pointer rounded-md border-none bg-transparent p-3 text-left transition-colors"
      style={{
        paddingLeft: 14,
        background: 'transparent',
        borderLeft:
          '2px solid ' + (isActive ? 'var(--accent)' : 'transparent'),
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface-2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="font-mono"
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            marginTop: 7,
            background:
              keywordSet.active === false ? 'var(--muted)' : 'var(--accent)',
          }}
        />
        <div className="flex-1 overflow-hidden">
          <p className="font-mono text-[13px] leading-snug" style={{ color: 'var(--text)' }}>
            {truncated || 'Untitled'}
          </p>

          {(unseenCount ?? 0) > 0 && (
            <span
              className="mt-1 inline-flex items-center rounded px-2 py-0.5 font-mono text-[11px]"
              style={{
                background: 'var(--accent)',
                color: '#07070b',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {String(unseenCount)}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}
