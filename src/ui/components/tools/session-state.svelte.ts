// Small per-session memories for the tool screens: they outlive a drawer being closed and opened
// again, and are forgotten on reload (nothing here is the player's data).

/** Ticks on the tracking test checklist (Appendix A), one per step. */
export const trackingTest = $state<{ done: boolean[] }>({ done: Array.from({ length: 10 }, () => false) });

/** The Workshop tab last shown. */
export const workshopView = $state<{ tab: string }>({ tab: 'settings' });

/** Files dropped on the app while the Workshop was closed: the shell opens the Workshop, which takes
 *  them from here and imports them as if they had been dropped on it. */
export const workshopInbox = $state<{ files: File[] }>({ files: [] });
