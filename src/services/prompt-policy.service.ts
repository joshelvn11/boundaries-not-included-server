export function inferPromptPickCount(promptText: string): number | null {
  const blankCount = promptText.match(/_+/g)?.length ?? 0;
  if (blankCount === 0) {
    return 1;
  }

  if (blankCount > 3) {
    return null;
  }

  return blankCount;
}
