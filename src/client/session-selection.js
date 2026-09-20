/**
 * Resolve the main conversation on retained-session and legacy hosts.
 * @param {{current?: string, byId?: Record<string, {id?: string, retainedBy?: {mainView?: number}}>}} state
 * @returns {string|undefined}
 */
export function mainSessionId(state) {
	return Object.values(state.byId ?? {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
		?? state.current;
}
