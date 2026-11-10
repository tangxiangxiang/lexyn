export const icons = {
  library: 'M4 6h4v14H4z M10 4h4v16h-4z M16 6l3-1 4 14-3 1z',
  learn: 'M3 12h4l3-8 4 16 3-8h4',
  review: 'M20 4.3v5h-5 M20 9.3l-2.1-2.1a8 8 0 1 0 0 9.6 M11.5 8v4l2.5 2',
  progress: 'M4 19h16 M7 15v-3 M12 15V8 M17 15V5',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  language: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z M2 12h20 M12 2c-5 5-5 15 0 20 M12 2c5 5 5 15 0 20',
  appearance: 'M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M18.4 5.6 17 7 M7 17l-1.4 1.4 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  missing: 'M12 4 3 20h18L12 4Z M12 10v4 M12 17h.01',
}

export type IconName = keyof typeof icons
