export type Umore = 'idle' | 'happy' | 'boh'

const LATI: Record<Umore, number[]> = { idle: [128], happy: [128, 256], boh: [256] }

// 'boh' è quadrata perché le mani escono dal cerchio; le altre sono cerchi.
export function NicuFace({ umore = 'idle', size = 40, className }: { umore?: Umore; size?: number; className?: string }) {
  const lati = LATI[umore]
  const lato = lati.find(l => l >= size * 2) ?? lati[lati.length - 1]
  const base = `/nicu-${umore}-${lato}`
  return (
    <picture>
      <source srcSet={`${base}.webp`} type="image/webp" />
      <img
        src={`${base}.png`}
        width={size}
        height={size}
        alt=""
        className={'nicu-face' + (className ? ' ' + className : '')}
        style={{ borderRadius: umore === 'boh' ? 0 : '50%' }}
        decoding="async"
      />
    </picture>
  )
}
