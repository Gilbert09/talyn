/** The SVGs are served from /file-icons by the fileIcons plugin in vite.config.ts. */
export const fileIconUrl = (name: string): string => `${import.meta.env.BASE_URL}file-icons/${name}.svg`;
