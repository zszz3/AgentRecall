import type { AgentModelReply } from "../../core/agent-model";
import { AgentModelNotReadyError } from "../../core/agent-model-config";
import {
  buildExtractionPrompt,
  extractionSearchTerms,
  parseExtractionResponse,
} from "../../core/experience-extraction";
import type { MemoryCard, MemoryCardEdit, PostgresMemoryCardRepository } from "../../core/postgres/memory-card-repository";
import type { AppSettings } from "../../core/platform";
import type { ExperienceCardStatus } from "../../shared/ipc/experience-cards";
import type { ExperienceCardsIpcService } from "../ipc/experience-cards";

export type ExperienceCardSettings = Pick<AppSettings, "experienceCardsEnabled" | "experienceCardsEnabledAt">;

export interface ExperienceCardServiceDependencies {
  repository: () => Promise<PostgresMemoryCardRepository>;
  settings: () => ExperienceCardSettings;
  /**
   * One call to the AgentRecall model; it must reject when `signal` aborts, and
   * with `AgentModelNotReadyError` while the model is not set up.
   */
  complete: (prompt: string, signal: AbortSignal) => Promise<AgentModelReply>;
  now?: () => Date;
}

const SESSIONS_PER_RUN = 3;
const CANDIDATE_CARDS = 10;
/** New Turns sent in one call; later Turns stay after the cursor and wait for the next pass. */
const TURNS_PER_CALL = 30;
const RETRY_POLICY = { maxAttempts: 5, baseDelayMs: 10 * 60 * 1000 };

/**
 * Owns background experience-card extraction in the desktop main process. One
 * run happens after each completed index pass; at most one run is active, and
 * turning extraction off or shutting down aborts it.
 */
export class ExperienceCardService implements ExperienceCardsIpcService {
  private current: { controller: AbortController; done: Promise<void> } | null = null;
  private lastRunError: string | null = null;

  constructor(readonly dependencies: ExperienceCardServiceDependencies) {}

  /**
   * `lastRunError` is a run that stopped before finishing its Sessions, such as
   * an unavailable database or a model that is not set up.
   */
  async status(): Promise<ExperienceCardStatus> {
    const now = this.dependencies.now?.() ?? new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const overview = await (await this.dependencies.repository()).extractionOverview(todayStart);
    return { ...overview, running: this.current !== null, lastRunError: this.lastRunError };
  }

  async listCards(options: { query: string; includeSuperseded: boolean }): Promise<MemoryCard[]> {
    return (await this.dependencies.repository()).listCards(options);
  }

  async editCard(id: string, edit: MemoryCardEdit): Promise<MemoryCard> {
    const card = await (await this.dependencies.repository()).editCard(id, edit, this.now());
    if (!card) throw new Error("This experience card no longer exists. Refresh the list.");
    return card;
  }

  async deleteCard(id: string): Promise<void> {
    await (await this.dependencies.repository()).deleteCard(id);
  }

  /** Failed Sessions become eligible again on the next completed index pass. */
  async retryFailed(sessionKey: string | null): Promise<number> {
    return (await this.dependencies.repository()).retryFailedExtractions(this.now(), sessionKey ?? undefined);
  }

  /** Starts one run unless extraction is off or already running. Never rejects. */
  afterIndexRun(): Promise<void> {
    const settings = this.dependencies.settings();
    if (this.current || !this.enabled(settings)) return Promise.resolve();
    const controller = new AbortController();
    const done = this.run(settings, controller.signal)
      .then(() => {
        this.lastRunError = null;
      }, (error: unknown) => {
        if (!controller.signal.aborted) this.lastRunError = errorMessage(error);
      })
      .finally(() => {
        if (this.current?.controller === controller) this.current = null;
      });
    this.current = { controller, done };
    return done;
  }

  /** Aborts the active run when extraction was turned off. */
  settingsChanged(): void {
    const settings = this.dependencies.settings();
    if (!this.enabled(settings)) this.current?.controller.abort();
  }

  async stop(): Promise<void> {
    const current = this.current;
    if (!current) return;
    current.controller.abort();
    await current.done;
  }

  private enabled(settings: ExperienceCardSettings): boolean {
    return settings.experienceCardsEnabled && Boolean(settings.experienceCardsEnabledAt);
  }

  private async run(settings: ExperienceCardSettings, signal: AbortSignal): Promise<void> {
    const repository = await this.dependencies.repository();
    const sessionKeys = await repository.pickExtractionSessions({
      enabledAt: settings.experienceCardsEnabledAt,
      now: this.now(),
      limit: SESSIONS_PER_RUN,
    });
    for (const sessionKey of sessionKeys) {
      if (signal.aborted) return;
      try {
        await this.extractSession(repository, settings, sessionKey, signal);
      } catch (error) {
        // An aborted call is not the model's failure; the Session is picked again on a later pass.
        if (signal.aborted) return;
        // No Session can succeed until the model is set up, so the run stops instead of spending their retries.
        if (error instanceof AgentModelNotReadyError) throw error;
        await repository.recordExtractionFailure(sessionKey, errorMessage(error), this.now(), RETRY_POLICY);
      }
    }
  }

  private async extractSession(
    repository: PostgresMemoryCardRepository,
    settings: ExperienceCardSettings,
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    const input = await repository.loadExtractionInput(sessionKey, settings.experienceCardsEnabledAt);
    if (!input) return;
    const turns = input.turns.slice(0, TURNS_PER_CALL);
    const first = turns[0];
    const last = turns.at(-1);
    if (!first || !last) return;
    const candidates = await repository.findSimilarCards(input.projectPath, extractionSearchTerms(turns), CANDIDATE_CARDS);
    const candidateIds = candidates.map((card) => card.id);
    const reply = await this.dependencies.complete(buildExtractionPrompt({ ...input, turns }, candidates), signal);
    const operations = parseExtractionResponse(reply.text, candidateIds);
    if (signal.aborted) return;
    await repository.applyExtraction({
      sessionKey,
      projectPath: input.projectPath,
      firstTurnIndex: first.turnIndex,
      lastTurnIndex: last.turnIndex,
      candidateIds,
      operations,
      model: reply.model,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      now: this.now(),
    });
  }

  private now(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
