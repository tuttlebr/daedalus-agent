/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    fontFamily: {
      'sans': ['NVIDIA Sans', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      'serif': ['Georgia', 'Cambria', 'Times New Roman', 'Times', 'serif'],
      'mono': ['JetBrains Mono', 'SF Mono', 'Monaco', 'Cascadia Code', 'Roboto Mono', 'Consolas', 'Courier New', 'monospace'],
    },
    fontWeight: {
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    extend: {
      // Fluid typography from design system
      fontSize: {
        'fluid-xs': 'var(--font-size-xs)',
        'fluid-sm': 'var(--font-size-sm)',
        'fluid-base': 'var(--font-size-base)',
        'fluid-lg': 'var(--font-size-lg)',
        'fluid-xl': 'var(--font-size-xl)',
        'fluid-2xl': 'var(--font-size-2xl)',
        'fluid-3xl': 'var(--font-size-3xl)',
        'fluid-4xl': 'var(--font-size-4xl)',
      },
      // Touch-friendly spacing
      spacing: {
        'safe-top': 'var(--safe-area-inset-top)',
        'safe-bottom': 'var(--safe-area-inset-bottom)',
        'safe-left': 'var(--safe-area-inset-left)',
        'safe-right': 'var(--safe-area-inset-right)',
        'touch-min': 'var(--touch-target-min)',
        'touch': 'var(--touch-target-comfortable)',
        'touch-lg': 'var(--touch-target-large)',
        'space-1': 'var(--space-1)',
        'space-2': 'var(--space-2)',
        'space-3': 'var(--space-3)',
        'space-4': 'var(--space-4)',
        'space-5': 'var(--space-5)',
        'space-6': 'var(--space-6)',
        'space-7': 'var(--space-7)',
        'space-8': 'var(--space-8)',
        'space-9': 'var(--space-9)',
        'space-10': 'var(--space-10)',
      },
      minHeight: {
        'touch-min': 'var(--touch-target-min)',
        'touch': 'var(--touch-target-comfortable)',
        'touch-lg': 'var(--touch-target-large)',
      },
      minWidth: {
        'touch-min': 'var(--touch-target-min)',
        'touch': 'var(--touch-target-comfortable)',
        'touch-lg': 'var(--touch-target-large)',
      },
      fontFamily: {
        'heading': ['NVIDIA Sans', 'system-ui', '-apple-system', 'sans-serif'],
        'display': ['NVIDIA Sans', 'system-ui', '-apple-system', 'sans-serif'],
        'nvidia': ['NVIDIA Sans', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        // Brand colors
        'nvidia-green': 'var(--color-nvidia-green)',
        'nvidia-green-dark': 'var(--color-nvidia-green-dark)',
        'nvidia-green-light': 'var(--color-nvidia-green-light)',
        'nvidia-green-bright': 'var(--color-nvidia-green-bright)',

        // Semantic colors
        'success': 'var(--color-success)',
        'error': 'var(--color-error)',
        'warning': 'var(--color-warning)',
        'info': 'var(--color-info)',

        // Gray scale
        'gray': {
          '50': 'var(--color-gray-50)',
          '100': 'var(--color-gray-100)',
          '200': 'var(--color-gray-200)',
          '300': 'var(--color-gray-300)',
          '400': 'var(--color-gray-400)',
          '500': 'var(--color-gray-500)',
          '600': 'var(--color-gray-600)',
          '700': 'var(--color-gray-700)',
          '800': 'var(--color-gray-800)',
          '900': 'var(--color-gray-900)',
        },

        // Light theme colors
        'bg': {
          'primary': 'var(--color-bg-primary)',
          'secondary': 'var(--color-bg-secondary)',
          'tertiary': 'var(--color-bg-tertiary)',
        },
        'text': {
          'primary': 'var(--color-text-primary)',
          'secondary': 'var(--color-text-secondary)',
          'muted': 'var(--color-text-muted)',
        },

        // Dark theme colors
        'dark-bg': {
          'primary': 'var(--color-dark-bg-primary)',
          'secondary': 'var(--color-dark-bg-secondary)',
          'tertiary': 'var(--color-dark-bg-tertiary)',
          'quaternary': 'var(--color-dark-bg-quaternary)',
        },
        'dark-text': {
          'primary': 'var(--color-dark-text-primary)',
          'secondary': 'var(--color-dark-text-secondary)',
          'muted': 'var(--color-dark-text-muted)',
        },

        // Border colors
        'border': {
          'light': 'var(--color-border)',
          'dark': 'var(--color-dark-border)',
        },

        // Chat specific colors
        'chat': {
          'user': 'var(--chat-bg-user)',
          'assistant': 'var(--chat-bg-assistant)',
          'border': 'var(--chat-border)',
          'input': 'var(--chat-input-bg)',
          'input-border': 'var(--chat-input-border)',
        },

        // Component colors
        'card': {
          'bg': 'var(--card-bg)',
          'border': 'var(--card-border)',
        },

        // Button colors
        'button': {
          'bg': 'var(--button-bg)',
          'hover': 'var(--button-hover)',
          'text': 'var(--button-text)',
        },
      },
      boxShadow: {
        'nvidia': '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
        'nvidia-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
        'glow-green': '0 0 20px rgba(118, 185, 0, 0.15)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-nvidia': 'linear-gradient(180deg, transparent, rgba(118, 185, 0, 0.05))',
      },
      screens: {
        'xs': '475px',
        ...require('tailwindcss/defaultTheme').screens,
      },
      fontSize: {
        'xs': ['0.75rem', { lineHeight: '1rem' }],
        'sm': ['0.875rem', { lineHeight: '1.25rem' }],
        'base': ['1rem', { lineHeight: '1.5rem' }],
        'lg': ['1.125rem', { lineHeight: '1.75rem' }],
        'xl': ['1.25rem', { lineHeight: '1.75rem' }],
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0 },
        },
        flicker: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        glitch: {
          '0%': { transform: 'translate(0)' },
          '20%': { transform: 'translate(-2px, 2px)' },
          '40%': { transform: 'translate(2px, -2px)' },
          '60%': { transform: 'translate(-2px, -2px)' },
          '80%': { transform: 'translate(2px, 2px)' },
          '100%': { transform: 'translate(0)' },
        },
        ghost: {
          '0%': { opacity: '0' },
          '50%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        flash: {
          '0%': { backgroundColor: 'rgba(255, 255, 255, 0)' },
          '50%': { backgroundColor: 'rgba(255, 255, 255, 0.5)' },
          '100%': { backgroundColor: 'rgba(255, 255, 255, 0)' },
        },
        crack1: {
          '0%': {
            transform: 'scale(1)',
            opacity: '1',
          },
          '20%': {
            transform: 'scale(1.05)',
            opacity: '0.8',
          },
          '40%': {
            transform: 'scale(1)',
            opacity: '0.6',
          },
          '60%': {
            transform: 'scale(0.95)',
            opacity: '0.4',
          },
          '80%': {
            transform: 'scale(1)',
            opacity: '0.2',
          },
          '100%': {
            transform: 'scale(1)',
            opacity: '0',
          },
        },
        darken: {
          '0%': { backgroundColor: 'rgba(0, 0, 0, 0)' },
          '100%': { backgroundColor: 'rgba(0, 0, 0, 0.7)' },
        },
        crack: {
          '0%': { backgroundSize: '100%', opacity: '1' },
          '50%': { backgroundSize: '120%', opacity: '1' },
          '100%': { backgroundSize: '100%', opacity: '0' },
        },
        loadingBar: {
          '0%': { transform: 'translateX(-100%)' },
          '50%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(100%)' },
        }
      },
      animation: {
        blink: 'blink 1s step-start infinite',
        flicker: 'flicker 1.5s infinite',
        glitch: 'glitch 1s infinite',
        ghost: 'ghost 3s ease-in-out infinite',
        flash: 'flash 0.5s ease-in-out', // Add your flash animation here
        crack: 'crack 0.6s ease-in-out forwards',
        darken: 'darken 1s forwards',
        loadingBar: 'loadingBar 2s ease-in-out infinite',
      },
    },
  },

  variants: {
    extend: {
      visibility: ['group-hover'],
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
