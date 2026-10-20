/** Called only from an explicit Copy action; supports trusted-LAN HTTP pages. */
export async function copyToClipboard(value: string): Promise<void> {
   try {
      if (navigator.clipboard?.writeText) {
         await navigator.clipboard.writeText(value);
         return;
      }
   } catch {
      // Try the browser's selection-based fallback when Clipboard API is denied.
   }
   const field = document.createElement('textarea');
   field.value = value;
   field.setAttribute('readonly', '');
   field.style.position = 'fixed';
   field.style.opacity = '0';
   document.body.appendChild(field);
   field.select();
   try {
      if (!document.execCommand('copy')) throw new Error('Clipboard access was denied.');
   } finally {
      field.remove();
   }
}
