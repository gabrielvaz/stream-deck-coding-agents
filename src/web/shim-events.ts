/** Browser stand-in for node:events (only what SessionStore uses). */
export class EventEmitter {
	private handlers = new Map<string, ((...args: unknown[]) => void)[]>();
	on(event: string, fn: (...args: unknown[]) => void): this {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
		return this;
	}
	emit(event: string, ...args: unknown[]): boolean {
		for (const fn of this.handlers.get(event) ?? []) fn(...args);
		return true;
	}
}
