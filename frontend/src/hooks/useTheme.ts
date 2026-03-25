import { useState, useEffect, useCallback } from "react";

export interface ThemeDefinition {
  id: string;
  name: string;
  vars: Record<string, string>;
  scanlines?: boolean;
}

export const themes: ThemeDefinition[] = [
  {
    id: "terminal",
    name: "Terminal",
    scanlines: true,
    vars: {
      "--bg": "#000000",
      "--surface": "#131313",
      "--surface-low": "#1b1b1b",
      "--surface-highest": "#353535",
      "--surface-bright": "#393939",
      "--outline": "#474747",
      "--text": "#FFFFFF",
      "--text-dim": "rgba(255, 255, 255, 0.5)",
      "--error": "#ffb4ab",
      "--ghost-border": "rgba(71, 71, 71, 0.2)",
      "--accent": "#3b82f6",
      "--success": "#4ade80",
    },
  },
  {
    id: "phosphor",
    name: "Phosphor",
    scanlines: true,
    vars: {
      "--bg": "#0a0e0a",
      "--surface": "#0f160f",
      "--surface-low": "#121a12",
      "--surface-highest": "#1e2e1e",
      "--surface-bright": "#253525",
      "--outline": "#2a3f2a",
      "--text": "#33ff33",
      "--text-dim": "rgba(51, 255, 51, 0.45)",
      "--error": "#ff4444",
      "--ghost-border": "rgba(51, 255, 51, 0.1)",
      "--accent": "#66ff66",
      "--success": "#33ff33",
    },
  },
  {
    id: "amber",
    name: "Amber",
    scanlines: true,
    vars: {
      "--bg": "#0e0a00",
      "--surface": "#161000",
      "--surface-low": "#1a1400",
      "--surface-highest": "#2e2400",
      "--surface-bright": "#352a00",
      "--outline": "#3f3200",
      "--text": "#ffb000",
      "--text-dim": "rgba(255, 176, 0, 0.45)",
      "--error": "#ff4444",
      "--ghost-border": "rgba(255, 176, 0, 0.1)",
      "--accent": "#ffc233",
      "--success": "#ffb000",
    },
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    scanlines: false,
    vars: {
      "--bg": "#0a0014",
      "--surface": "#12001f",
      "--surface-low": "#180028",
      "--surface-highest": "#2a0045",
      "--surface-bright": "#350055",
      "--outline": "#4a0070",
      "--text": "#e0e0ff",
      "--text-dim": "rgba(224, 224, 255, 0.5)",
      "--error": "#ff2060",
      "--ghost-border": "rgba(180, 0, 255, 0.15)",
      "--accent": "#b400ff",
      "--success": "#00ff88",
    },
  },
  {
    id: "arctic",
    name: "Arctic",
    scanlines: false,
    vars: {
      "--bg": "#0b1622",
      "--surface": "#0f1d2e",
      "--surface-low": "#132438",
      "--surface-highest": "#1e3a54",
      "--surface-bright": "#244560",
      "--outline": "#2d5577",
      "--text": "#d4e8ff",
      "--text-dim": "rgba(212, 232, 255, 0.5)",
      "--error": "#ff6b6b",
      "--ghost-border": "rgba(100, 180, 255, 0.12)",
      "--accent": "#64b5f6",
      "--success": "#4ade80",
    },
  },
  {
    id: "blood",
    name: "Blood",
    scanlines: false,
    vars: {
      "--bg": "#0e0000",
      "--surface": "#1a0505",
      "--surface-low": "#200808",
      "--surface-highest": "#3a1010",
      "--surface-bright": "#451515",
      "--outline": "#551a1a",
      "--text": "#ffcccc",
      "--text-dim": "rgba(255, 204, 204, 0.5)",
      "--error": "#ff4040",
      "--ghost-border": "rgba(255, 50, 50, 0.12)",
      "--accent": "#ff4040",
      "--success": "#ff8080",
    },
  },
  {
    id: "snow",
    name: "Snow",
    scanlines: false,
    vars: {
      "--bg": "#f0f0f0",
      "--surface": "#e0e0e0",
      "--surface-low": "#e8e8e8",
      "--surface-highest": "#d0d0d0",
      "--surface-bright": "#c8c8c8",
      "--outline": "#aaaaaa",
      "--text": "#1a1a1a",
      "--text-dim": "rgba(26, 26, 26, 0.5)",
      "--error": "#cc0000",
      "--ghost-border": "rgba(0, 0, 0, 0.1)",
      "--accent": "#2563eb",
      "--success": "#16a34a",
    },
  },
];

const STORAGE_KEY = "synced-theme";
const DEFAULT_THEME = "terminal";

function applyTheme(theme: ThemeDefinition) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  // Toggle scanlines
  document.body.classList.toggle("no-scanlines", !theme.scanlines);
}

export default function useTheme() {
  const [themeId, setThemeId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  });

  useEffect(() => {
    const theme = themes.find((t) => t.id === themeId) || themes[0];
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, themeId);
    } catch {
      // storage full or blocked
    }
  }, [themeId]);

  const setTheme = useCallback((id: string) => {
    setThemeId(id);
  }, []);

  return { themeId, setTheme, themes };
}
