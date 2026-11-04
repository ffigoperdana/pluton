import { createContext, useContext, useSyncExternalStore } from 'react';
import { ExportActivityManager } from '../utils/exportActivity';

export const ExportActivityContext = createContext<ExportActivityManager | undefined>(undefined);
export function useExportActivity() {
   const manager = useContext(ExportActivityContext);
   if (!manager) throw new Error('Reliable Download requires the authenticated activity provider.');
   return { manager, ...useSyncExternalStore(manager.subscribe, manager.snapshot, manager.snapshot) };
}
