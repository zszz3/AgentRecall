import type { AppSnapshot } from "../../../../automation/contracts";

type StoreListener = () => void;

export class AutomationStore {
  private snapshotValue: AppSnapshot;
  private readonly listeners = new Set<StoreListener>();

  constructor(initial: AppSnapshot) {
    this.snapshotValue = initial;
  }

  getSnapshot = (): AppSnapshot => this.snapshotValue;

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(next: AppSnapshot): void {
    this.snapshotValue = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
