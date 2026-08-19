/**
 * Local-model header control plugin, node half. Pure UI plugin: the empty
 * apply exists so the plugin appears in the host cordis.yml / Loader; the
 * browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration. The underlying /local-model command is
 * owned by `@deepseek-ai/dsh-command-local-model`, composed independently on
 * the host roster.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
