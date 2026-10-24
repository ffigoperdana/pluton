import type { DeviceSettings } from '../@types/devices';

/** Send only intentional edits; blank optional fields never reset stored host configuration. */
export function deviceSettingsPayload(
   original: { name: string; settings?: DeviceSettings | null },
   edited: { name: string; settings?: DeviceSettings },
   remote: boolean,
): { name: string; settings?: Record<string, Record<string, unknown>> } {
   const result: { name: string; settings?: Record<string, Record<string, unknown>> } = { name: edited.name.trim() };
   if (remote) return result;
   const settings: Record<string, Record<string, unknown>> = {};
   for (const section of ['general', 'restic', 'rclone'] as const) {
      const before = original.settings?.[section] || {};
      for (const [key, value] of Object.entries(edited.settings?.[section] || {})) {
         if (value === undefined || (typeof value === 'string' && !value.trim())) continue;
         if (value !== (before as Record<string, unknown>)[key]) (settings[section] ||= {})[key] = value;
      }
   }
   if (Object.keys(settings).length) result.settings = settings;
   return result;
}
