import type { ReactNode } from 'react'

const Icona = ({ children, className }: { children: ReactNode; className?: string }) => (
  <svg
    className={className}
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)

export const IconaCondividi = () => (<Icona><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="M12 16V3" /><path d="m7 8 5-5 5 5" /></Icona>)
export const IconaOk = () => (<Icona><path d="M20 6 9 17l-5-5" /></Icona>)
export const IconaInfo = () => (<Icona><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></Icona>)
export const IconaNuovaChat = () => (<Icona><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icona>)
export const IconaInvia = () => (<Icona><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></Icona>)
export const IconaStop = () => (<Icona><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></Icona>)
export const IconaChiudi = () => (<Icona><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icona>)
export const IconaGiu = () => (<Icona><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></Icona>)
export const IconaFreccia = ({ aperta }: { aperta: boolean }) => (<Icona className={aperta ? 'freccia aperta' : 'freccia'}><path d="m6 9 6 6 6-6" /></Icona>)
export const IconaTelefono = () => (<Icona><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M11 18h2" /></Icona>)
export const IconaComputer = () => (<Icona><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icona>)
export const IconaTablet = () => (<Icona><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M11 18h2" /></Icona>)
export const IconaNuvola = () => (<Icona><path d="M17.5 19H7a5 5 0 1 1 1.2-9.85A6 6 0 0 1 19.8 11 4 4 0 0 1 17.5 19Z" /></Icona>)
