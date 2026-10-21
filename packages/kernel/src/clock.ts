export interface Clock { now(): number }
export interface IdGenerator { next(): string }
export const systemClock: Clock = { now: () => Date.now() };
export const randomId: IdGenerator = { next: () => crypto.randomUUID() };
