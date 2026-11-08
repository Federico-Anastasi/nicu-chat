// Sullo Space Hugging Face il sito gira solo in modalità «sul telefono» e non ha un backend suo.
export const IS_HF_SPACE = typeof window !== 'undefined' && window.location.host.endsWith('.hf.space')
