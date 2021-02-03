// @ts-check

/**
 * @typedef {CapData<string>} CapDataS
 */

/**
 * @typedef {{
 *   bundle: unknown,
 *   enableSetup: false,
 * }} HasBundle
 * @typedef {{
 *   setup: unknown,
 *   enableSetup: true,
 * }} HasSetup
 *
 * TODO: metered...
 *
 * See validateManagerOptions() in factory.js
 * @typedef {{
 *   managerType: 'local' | 'nodeWorker' | 'node-subprocess' | 'xs-worker',
 *   metered?: boolean,
 *   enableInternalMetering?: boolean,
 *   vatParameters: Record<string, unknown>,
 *   virtualObjectCacheSize: number,
 * } & (HasBundle | HasSetup)} ManagerOptions
 */
