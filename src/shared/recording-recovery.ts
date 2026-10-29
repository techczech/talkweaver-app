/** An interrupted recording that launch/window-close recovery has not completed. */
export type RecordingRecovery = {
  sessionId: string
  talkSlug: string
  talkTitle: string
  status: 'waiting-for-vault' | 'needs-attention' | 'ready'
  message: string
}
