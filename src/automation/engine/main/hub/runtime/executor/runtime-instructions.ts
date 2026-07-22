export function combineDeveloperInstructions(
  ...instructions: Array<string | undefined>
): string {
  return instructions
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

export function promptWithDeveloperInstructions(
  prompt: string,
  developerInstructions: string | undefined,
): string {
  const instructions = developerInstructions?.trim();
  return instructions ? `${instructions}\n\nUser request:\n${prompt}` : prompt;
}
