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
        // =============================================================
        // NVIDIA BRAND COLORS (from COLORS.md)
        // =============================================================

        // Primary Brand Color - NVIDIA Green
        'nvidia-green': 'var(--color-nvidia-green)',
        'nvidia-green-dark': 'var(--color-nvidia-green-dark)',
        'nvidia-green-light': 'var(--color-nvidia-green-light)',
        'nvidia-green-bright': 'var(--color-nvidia-green-bright)',

        // Complimentary Colors
        'nvidia-purple': {
          DEFAULT: 'var(--color-nvidia-purple)',
          light: 'var(--color-nvidia-purple-light)',
          dark: 'var(--color-nvidia-purple-dark)',
        },
        'nvidia-orange': {
          DEFAULT: 'var(--color-nvidia-orange)',
          light: 'var(--color-nvidia-orange-light)',
          dark: 'var(--color-nvidia-orange-dark)',
        },

        // Functional Colors
        'nvidia-yellow': {
          DEFAULT: 'var(--color-nvidia-yellow)',
          light: 'var(--color-nvidia-yellow-light)',
          dark: 'var(--color-nvidia-yellow-dark)',
        },
        'nvidia-blue': {
          DEFAULT: 'var(--color-nvidia-blue)',
          light: 'var(--color-nvidia-blue-light)',
          dark: 'var(--color-nvidia-blue-dark)',
        },
        'nvidia-red': {
          DEFAULT: 'var(--color-nvidia-red)',
          light: 'var(--color-nvidia-red-light)',
          dark: 'var(--color-nvidia-red-dark)',
        },

        // Supporting Colors
        'nvidia-magenta': {
          DEFAULT: 'var(--color-nvidia-magenta)',
          light: 'var(--color-nvidia-magenta-light)',
          dark: 'var(--color-nvidia-magenta-dark)',
        },
        'nvidia-teal': {
          DEFAULT: 'var(--color-nvidia-teal)',
          light: 'var(--color-nvidia-teal-light)',
          dark: 'var(--color-nvidia-teal-dark)',
        },

        // =============================================================
        // Extended Green Spectrum
        // =============================================================
        'sage': {
          DEFAULT: 'var(--color-sage)',
          light: 'var(--color-sage-light)',
          dark: 'var(--color-sage-dark)',
        },
        'emerald': {
          DEFAULT: 'var(--color-emerald)',
          light: 'var(--color-emerald-light)',
          dark: 'var(--color-emerald-dark)',
        },
        'lime': {
          DEFAULT: 'var(--color-lime)',
          light: 'var(--color-lime-light)',
          dark: 'var(--color-lime-dark)',
        },

        // Semantic colors
        'success': {
          DEFAULT: 'var(--color-success)',
          light: 'var(--color-success-light)',
          dark: 'var(--color-success-dark)',
        },
        'error': {
          DEFAULT: 'var(--color-error)',
          light: 'var(--color-error-light)',
          dark: 'var(--color-error-dark)',
        },
        'warning': {
          DEFAULT: 'var(--color-warning)',
          light: 'var(--color-warning-light)',
          dark: 'var(--color-warning-dark)',
        },
        'info': {
          DEFAULT: 'var(--color-info)',
          light: 'var(--color-info-light)',
          dark: 'var(--color-info-dark)',
        },

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
        // Glass surfaces
        'surface': {
          'glass': 'var(--surface-glass)',
          'glass-hover': 'var(--surface-glass-hover)',
          'control': 'var(--surface-glass-control)',
          'overlay': 'var(--surface-glass-overlay)',
          'accent': 'var(--surface-accent)',
        },

        // Border colors
        'border': {
          'light': 'var(--color-border)',
          'dark': 'var(--color-dark-border)',
          'glass': 'var(--surface-glass-border)',
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
          'accent-bg': 'var(--button-accent-bg)',
          'accent-hover': 'var(--button-accent-hover)',
        },
      },
      boxShadow: {
        'nvidia': '0 0 5px 0 rgba(0, 0, 0, 0.3)',
        'nvidia-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
        'nvidia-dropdown': '0 6px 9px rgba(0, 0, 0, 0.175)',
        'glow-green': '0 0 20px rgba(118, 185, 0, 0.15)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-nvidia': 'linear-gradient(180deg, transparent, rgba(118, 185, 0, 0.05))',
        'gradient-green-primary': 'var(--gradient-green-primary)',
        'gradient-green-subtle': 'var(--gradient-green-subtle)',
        'gradient-dark': 'var(--gradient-dark)',
        'gradient-light': 'var(--gradient-light)',
      },
      backdropBlur: {
        xs: '2px',
        sm: '4px',
        DEFAULT: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        '2xl': '40px',
        '3xl': '64px',
      },
      backdropSaturate: {
        0: '0',
        50: '.5',
        100: '1',
        150: '1.5',
        180: '1.8',
        200: '2',
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
        },
        // SRD Animation Keyframes
        'heartbeat-sweep': {
          '0%': { backgroundPosition: '-100% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'heartbeat-breathe': {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.4' },
          '50%': { transform: 'scale(1.3)', opacity: '1' },
        },
        'morph-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'morph-out': {
          from: { opacity: '1', transform: 'translateY(0)' },
          to: { opacity: '0', transform: 'translateY(8px)' },
        },
        'slide-panel-in': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-panel-out': {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-100%)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'galaxy-float': {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '25%': { transform: 'translate(10px, -10px)' },
          '50%': { transform: 'translate(-5px, 15px)' },
          '75%': { transform: 'translate(-15px, -5px)' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%, 30%, 50%, 70%, 90%': { transform: 'translateX(-4px)' },
          '20%, 40%, 60%, 80%': { transform: 'translateX(4px)' },
        },
      },
      animation: {
        blink: 'blink 1s step-start infinite',
        flicker: 'flicker 1.5s infinite',
        glitch: 'glitch 1s infinite',
        ghost: 'ghost 3s ease-in-out infinite',
        flash: 'flash 0.5s ease-in-out',
        crack: 'crack 0.6s ease-in-out forwards',
        darken: 'darken 1s forwards',
        loadingBar: 'loadingBar 2s ease-in-out infinite',
        // SRD Animations
        'heartbeat-sweep': 'heartbeat-sweep 1.8s ease-in-out infinite',
        'heartbeat-breathe': 'heartbeat-breathe 2s ease-in-out infinite',
        'morph-in': 'morph-in 0.3s ease-out forwards',
        'morph-out': 'morph-out 0.2s ease-in forwards',
        'slide-panel-in': 'slide-panel-in 0.3s ease-out forwards',
        'slide-panel-out': 'slide-panel-out 0.2s ease-in forwards',
        'scale-in': 'scale-in 0.2s ease-out forwards',
        'galaxy-float': 'galaxy-float 20s ease-in-out infinite',
        shake: 'shake 0.5s ease-in-out',
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
