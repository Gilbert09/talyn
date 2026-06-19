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
      screens: { "2xl": "1180px" },
    },
    extend: {
      colors: {
        // Warm paper surfaces (page + cards).
        paper: {
          DEFAULT: "#f8f5f0",
          50: "#fcfbf8",
          100: "#f5f1ea",
          200: "#efe9df",
          300: "#e7ded1",
        },
        // Warm charcoal ink (text), stepping down into muted grays.
        ink: {
          DEFAULT: "#23201b",
          700: "#3d3830",
          600: "#5c554a",
          500: "#7a7264",
          400: "#9a9183",
        },
        // Single signature accent: terracotta / clay.
        clay: {
          DEFAULT: "#c25e3a",
          600: "#a64e2f",
          500: "#c25e3a",
          400: "#cf7553",
          300: "#dd9a7e",
          200: "#ecc4b1",
          100: "#f5e2d7",
        },
        line: {
          DEFAULT: "#e8e1d6",
          strong: "#dbd1c2",
        },
        // Product status semantics, tuned for light surfaces.
        status: {
          green: "#15a34a",
          red: "#dc2626",
          amber: "#d97706",
          blue: "#2563eb",
          purple: "#7c3aed",
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
        soft: "0 1px 2px rgba(35,32,27,0.04), 0 14px 40px -18px rgba(35,32,27,0.16)",
        card: "0 1px 0 0 rgba(255,255,255,0.6) inset, 0 12px 30px -16px rgba(35,32,27,0.14)",
        frame:
          "0 1px 0 0 rgba(255,255,255,0.7) inset, 0 40px 90px -40px rgba(35,32,27,0.30)",
        "glow-clay": "0 26px 70px -34px rgba(194,94,58,0.45)",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 92%, 100%": { opacity: "1" },
          "94%, 98%": { opacity: "0.2" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.9)", opacity: "0.55" },
          "100%": { transform: "scale(1.7)", opacity: "0" },
        },
        scan: {
          "0%, 100%": { transform: "translateX(-40%)", opacity: "0" },
          "50%": { transform: "translateX(40%)", opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.6s ease both",
        blink: "blink 5s ease-in-out infinite",
        "pulse-ring": "pulse-ring 2.4s ease-out infinite",
        scan: "scan 3.5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
