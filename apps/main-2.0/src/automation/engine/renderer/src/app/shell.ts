export function missingAppCapabilityMessage(action: string): string {
  return `${action} needs a full app restart to load the updated Electron API.`;
}
