export class ProcessLease {
  private attachmentGeneration: number;
  private turnCounter = 0;

  constructor(initialGeneration = 0) {
    this.attachmentGeneration = Math.max(0, Math.floor(initialGeneration));
  }

  nextGeneration(): number {
    this.attachmentGeneration += 1;
    this.turnCounter = 0;
    return this.attachmentGeneration;
  }

  currentGeneration(): number {
    return this.attachmentGeneration;
  }

  nextTurnId(): string {
    this.turnCounter += 1;
    return `turn-${this.attachmentGeneration}-${this.turnCounter}`;
  }

  matchesGeneration(expected: number): boolean {
    return this.attachmentGeneration === expected;
  }

  syncGeneration(expected: number): number {
    const nextGeneration = Math.max(0, Math.floor(expected));
    if (nextGeneration > this.attachmentGeneration) {
      this.attachmentGeneration = nextGeneration;
      this.turnCounter = 0;
    }
    return this.attachmentGeneration;
  }

  nextAttachmentGeneration(): number {
    return this.nextGeneration();
  }

  currentAttachmentGeneration(): number {
    return this.currentGeneration();
  }

  matchesAttachment(expected: number): boolean {
    return this.matchesGeneration(expected);
  }

  syncAttachmentGeneration(expected: number): number {
    return this.syncGeneration(expected);
  }
}
