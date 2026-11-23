/**
 * The model manager's stylesheet, injected with the dialog.
 *
 * Class names carry the `dsh-cursor-` prefix and sit under `.dsh-cursor-manager`,
 * so the rules cannot reach another surface. Colors and type come from the
 * host's theme tokens, so light and dark both work without a theme branch, and
 * the dialog's form controls keep the geometry `provider-settings-styles`
 * already gives them.
 */
export const cursorManagerCss = [
  '.dsh-cursor-manager .dsh-cursor-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
  '.dsh-cursor-manager .dsh-cursor-toolbar input { flex: 1 1 180px; }',
  '.dsh-cursor-manager .dsh-cursor-summary { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
  '.dsh-cursor-manager .dsh-cursor-models { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }',
  '.dsh-cursor-manager .dsh-cursor-model { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 8px 2px; border-top: 0.5px solid var(--dsw-alias-border-l2); min-width: 0; }',
  '.dsh-cursor-manager .dsh-cursor-model:first-child { border-top: 0; }',
  '.dsh-cursor-manager .dsh-cursor-model-head { display: flex; align-items: center; gap: 6px; flex: 1 1 220px; min-width: 0; }',
  '.dsh-cursor-manager .dsh-cursor-model-name { font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }',
  '.dsh-cursor-manager .dsh-cursor-model-id { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }',
  '.dsh-cursor-manager .dsh-cursor-model-off .dsh-cursor-model-name { color: var(--dsw-alias-label-dimmed); }',
  '.dsh-cursor-manager .dsh-cursor-model-controls { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }',
  '.dsh-cursor-manager .dsh-cursor-chip { padding: 2px 8px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; white-space: nowrap; }',
  '.dsh-cursor-manager .dsh-cursor-window-input { width: 110px; min-width: 0; height: 28px; }',
  '.dsh-cursor-manager .dsh-cursor-icon { min-width: 28px; min-height: 28px; padding: 0 6px; border-color: transparent; color: var(--dsw-alias-label-secondary); }',
  '.dsh-cursor-manager .dsh-cursor-model-error { flex: 1 0 100%; margin: 0; }',
  '.dsh-cursor-manager .dsh-cursor-section { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); }',
  '.dsh-cursor-manager .dsh-cursor-section-actions { display: flex; gap: 8px; flex-wrap: wrap; }',
  '.dsh-cursor-manager .dsh-cursor-list { max-height: 340px; overflow-y: auto; min-height: 0; }',
  '.dsh-cursor-manager .dsh-cursor-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }',
  /* A narrow dialog stacks the controls under the name: the id and the catalog
     note otherwise squeeze the name into a column a few characters wide. */
  '@media (max-width: 560px) { .dsh-cursor-manager .dsh-cursor-model { flex-direction: column; align-items: stretch; gap: 6px; } .dsh-cursor-manager .dsh-cursor-model-head { flex: 1 1 auto; } .dsh-cursor-manager .dsh-cursor-model-controls { justify-content: flex-end; } }',
].join('\n')
