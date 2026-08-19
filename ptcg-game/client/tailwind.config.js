/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Dark battle-table felt gradient — collapses the hand-repeated hex triplet used across
        // Battle.tsx's board/panel/modal backgrounds into one place. `feltFrom` is the variant
        // used only by the turn-log panel background (slightly darker top stop than `felt.from`).
        battle: {
          // Deeper contrast than the original flat green (brighter highlight up top, near-black
          // at the rim) for a "spotlit table" feel rather than a uniform tint — paired with the
          // vignette overlay in Battle.tsx's board/select-deck backgrounds.
          felt: {
            from: '#1c6b3c',
            via: '#052e16',
            to: '#020a06',
          },
          feltFrom: '#0a2417',
          // Warm accent reserved for "premium"/reward moments (win screen, prize gems) — kept
          // separate from the functional status colors (sky=target, emerald=selected, red=danger)
          // so it never gets mistaken for an interactive affordance.
          gold: '#f5c451',
        },
        // Light theme reserved for the home page — the one intentionally light-on-dark exception
        // in an otherwise dark app; do not use these outside Home.tsx.
        home: {
          bg: '#f8fafc',
          surface: '#ffffff',
          border: '#e2e8f0',
          accent: '#2563eb',
        },
      },
      keyframes: {
        'card-enter': {
          '0%': { opacity: '0', transform: 'scale(0.6) translateY(14px)' },
          '60%': { opacity: '1', transform: 'scale(1.05) translateY(-2px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-6px)' },
          '40%': { transform: 'translateX(6px)' },
          '60%': { transform: 'translateX(-4px)' },
          '80%': { transform: 'translateX(4px)' },
        },
        'float-up': {
          '0%': { opacity: '0', transform: 'translateY(4px) scale(0.9)' },
          '15%': { opacity: '1', transform: 'translateY(-4px) scale(1.15)' },
          '100%': { opacity: '0', transform: 'translateY(-42px) scale(1)' },
        },
        'ko-flash': {
          '0%': { opacity: '0', transform: 'scale(0.5) rotate(-6deg)' },
          '20%': { opacity: '1', transform: 'scale(1.15) rotate(3deg)' },
          '35%': { opacity: '1', transform: 'scale(1) rotate(0deg)' },
          '80%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        'result-pop': {
          '0%': { opacity: '0', transform: 'scale(0.8) translateY(16px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.65', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.06)' },
        },
      },
      animation: {
        'card-enter': 'card-enter 0.35s cubic-bezier(0.34,1.56,0.64,1) both',
        shake: 'shake 0.4s ease-in-out',
        'float-up': 'float-up 1.1s ease-out forwards',
        'ko-flash': 'ko-flash 1.1s ease-out forwards',
        'result-pop': 'result-pop 0.5s cubic-bezier(0.34,1.56,0.64,1) both',
        'glow-pulse': 'glow-pulse 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
