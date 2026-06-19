import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1200px" },
    },
    extend: {
      colors: {
        // Brand DNA carried over from the desktop owl icon.
        ink: {
          DEFAULT: "#030816", // deepest navy-black (page base)
          900: "#050b1c",
          800: "#0a1226",
          700: "#16203a",
        },
        owl: {
          // owl-blue accents from icon.svg (#7da2e8 / #aac4f5 / #eef3fb)
          50: "#eef3fb",
          200: "#aac4f5",
          400: "#7da2e8",
          600: "#3b5a9a",
          700: "#22345e",
        },
        // Signature "talon" gold — the pop colour for CTAs / highlights.
        talon: {
          DEFAULT: "#f5b94d",
          300: "#ffd98a",
          400: "#f5b94d",
          500: "#e89a2b",
          600: "#c97d18",
        },
        // Product status semantics, mirrored from the app.
        status: {
          green: "#34d399",
          red: "#f87171",
          amber: "#fbbf24",
          blue: "#60a5fa",
          purple: "#a78bfa",
        },
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "0.75rem",
        xl: "1rem",
        "2xl": "1.25rem",
      },
      boxShadow: {
        glow: "0 0 80px -20px rgba(125,162,232,0.45)",
        "glow-talon": "0 0 60px -18px rgba(245,185,77,0.55)",
        frame:
          "0 1px 0 0 rgba(255,255,255,0.06) inset, 0 40px 120px -40px rgba(0,0,0,0.8)",
      },
      backgroundImage: {
        "grid-fade":
          "linear-gradient(to bottom, transparent, hsl(var(--background)))",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 92%, 100%": { opacity: "1" },
          "94%, 98%": { opacity: "0.15" },
        },
        marquee: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-50%)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.9)", opacity: "0.6" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
        scan: {
          "0%, 100%": { transform: "translateX(-40%)", opacity: "0" },
          "50%": { transform: "translateX(40%)", opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.6s ease both",
        blink: "blink 5s ease-in-out infinite",
        marquee: "marquee 32s linear infinite",
        "pulse-ring": "pulse-ring 2.4s ease-out infinite",
        scan: "scan 3.5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
