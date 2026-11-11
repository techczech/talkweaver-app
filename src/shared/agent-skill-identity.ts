// What is TalkWeaver's in the built-in agent skill (the portable module in src/shared/agent-skill/ and
// src/main/agent-skill/ takes these as parameters): read by main and by the renderer.
// Pure; erasable TypeScript only.
export const AGENT_SKILL_IDENTITY = {
  appId: 'talkweaver',
  appName: 'TalkWeaver',
  skillName: 'talkweaver',
  /** What the skill lets the person ask an agent for (the offer's sentence, in the person's terms). */
  features: 'create and edit your presentations',
  tryExample: (agent: string): string => `Ask ${agent} to make a ten-slide talk on how bees find flowers.`,
  cli: { command: 'talkweaver', appName: 'TalkWeaver', bundleId: 'com.techczech.talkweaver' }
} as const
