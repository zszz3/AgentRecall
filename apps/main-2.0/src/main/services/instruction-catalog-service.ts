import path from "node:path";

import { findInstructionFiles, readInstructionFile, type InstructionFile } from "../../core/instruction-files";

export interface InstructionCatalogDependencies {
  home: string;
  env: Record<string, string | undefined>;
  /** Folders of local projects that have Sessions, most relevant first. */
  localProjects(): Promise<string[]>;
  /** Opens the file in its default app; resolves to an error message, empty on success. */
  openPath(file: string): Promise<string>;
  revealPath(file: string): void;
}

/**
 * Lists the instruction files agents read on this machine and gives the renderer access to
 * those files only: any other path is refused, so the page cannot be used to read arbitrary files.
 */
export class InstructionCatalogService {
  private listed = new Set<string>();

  constructor(private readonly dependencies: InstructionCatalogDependencies) {}

  async list(): Promise<InstructionFile[]> {
    const { home, env, localProjects } = this.dependencies;
    const files = await findInstructionFiles({ home, env, projects: await localProjects() });
    this.listed = new Set(files.flatMap((file) => [file.path, ...file.aliases]));
    return files;
  }

  async read(file: string): Promise<string> {
    await this.ensureListed(file);
    return readInstructionFile(file);
  }

  async open(file: string): Promise<void> {
    await this.ensureListed(file);
    const error = await this.dependencies.openPath(file);
    if (error) throw new Error(`Could not open ${path.basename(file)}: ${error}`);
  }

  async reveal(file: string): Promise<void> {
    await this.ensureListed(file);
    this.dependencies.revealPath(file);
  }

  /** The page may ask for a file before or long after it listed them, so look once more before refusing. */
  private async ensureListed(file: string): Promise<void> {
    if (this.listed.has(file)) return;
    await this.list();
    if (!this.listed.has(file)) throw new Error(`${path.basename(file)} is not one of the instruction files any more. Refresh the list and try again.`);
  }
}
